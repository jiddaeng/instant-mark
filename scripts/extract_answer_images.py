#!/usr/bin/env python3
"""Extract per-problem answer and solution images from the local answer PDF.

The current workbook uses a two-column layout. Problem blocks are read in this
order:

    page N left column -> page N right column -> page N+1 left column -> ...

A solution may continue into the next column or page. This script joins those
continuation regions vertically into one PNG for each problem.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps


CONTENT_TOP_PT = 32.0
CONTENT_BOTTOM_PT = 800.0
HEADER_HEIGHT_MIN_PT = 20.0
HEADER_HEIGHT_MAX_PT = 25.0
HEADER_TOP_PAD_PT = 2.0
HEADER_BOTTOM_PAD_PT = 3.0
SOLUTION_TOP_PAD_PT = 1.0
NEXT_HEADER_GAP_PT = 5.0
COLUMN_SIDE_PAD_PT = 3.0
VERTICAL_TRIM_MARGIN_PX = 10
SEGMENT_JOIN_GAP_PX = 14
NONWHITE_THRESHOLD = 248
FOOTER_BRAND_LEFT_PT = 275.0
FOOTER_BRAND_RIGHT_PT = 377.0
FOOTER_BRAND_TOP_PT = 785.0
FOOTER_BRAND_BOTTOM_PT = 807.0


@dataclass(frozen=True)
class Header:
    number: int
    page_no: int
    column: int
    x0: float
    y0: float
    y1: float


@dataclass(frozen=True)
class Layout:
    first_content_page: int
    column_x: dict[tuple[int, int], float]
    column_width: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract answer and solution PNGs from a two-column answer PDF."
    )
    parser.add_argument(
        "--pdf",
        type=Path,
        default=Path("answer_sheets/gojangee_gongsutwo.pdf"),
        help="Source PDF path.",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path("."),
        help="Project root containing images/ and data.json.",
    )
    parser.add_argument(
        "--scale",
        type=float,
        default=2.0,
        help="Raster scale. 2.0 produces roughly 144 dpi.",
    )
    parser.add_argument(
        "--max-problems",
        type=int,
        default=None,
        help="Optional extraction limit for a quick test run.",
    )
    return parser.parse_args()


def find_headers(document: pymupdf.Document) -> list[Header]:
    headers: list[Header] = []

    for page_index, page in enumerate(document):
        page_no = page_index + 1
        page_midpoint = page.rect.width / 2

        for word in page.get_text("words", sort=False):
            x0, y0, _x1, y1, text, *_ = word
            text = text.strip()
            height = y1 - y0

            if (
                len(text) == 3
                and text.isdigit()
                and HEADER_HEIGHT_MIN_PT < height < HEADER_HEIGHT_MAX_PT
                and y0 < CONTENT_BOTTOM_PT
            ):
                headers.append(
                    Header(
                        number=int(text),
                        page_no=page_no,
                        column=0 if x0 < page_midpoint else 1,
                        x0=x0,
                        y0=y0,
                        y1=y1,
                    )
                )

    headers.sort(key=lambda item: (item.page_no, item.column, item.y0))
    if not headers:
        raise RuntimeError("문항 머리표(예: 001)를 PDF에서 찾지 못했습니다.")

    numbers = [header.number for header in headers]
    expected = list(range(numbers[0], numbers[-1] + 1))
    if numbers != expected:
        mismatches = [
            f"위치 {index + 1}: 예상 {expected_number:03d}, 감지 {actual_number:03d}"
            for index, (expected_number, actual_number) in enumerate(
                zip(expected, numbers)
            )
            if expected_number != actual_number
        ]
        if len(numbers) != len(expected):
            mismatches.append(
                f"감지 개수 {len(numbers)}, 예상 개수 {len(expected)}"
            )
        detail = "; ".join(mismatches[:8])
        raise RuntimeError(f"문항 번호가 연속적이지 않습니다. {detail}")

    return headers


def infer_layout(document: pymupdf.Document, headers: list[Header]) -> Layout:
    samples: dict[tuple[int, int], list[float]] = {
        (0, 0): [],
        (0, 1): [],
        (1, 0): [],
        (1, 1): [],
    }
    for header in headers:
        samples[(header.page_no % 2, header.column)].append(header.x0)

    missing = [key for key, values in samples.items() if not values]
    if missing:
        raise RuntimeError(f"열 위치를 추정할 표본이 부족합니다: {missing}")

    column_x = {
        key: statistics.median(values) for key, values in samples.items()
    }
    page_width = statistics.median(page.rect.width for page in document)
    even_left_margin = column_x[(0, 0)]
    odd_left_margin = column_x[(1, 0)]
    column_steps = [
        column_x[(parity, 1)] - column_x[(parity, 0)] for parity in (0, 1)
    ]
    column_step = statistics.median(column_steps)
    column_width = page_width - even_left_margin - odd_left_margin - column_step

    if not 200.0 < column_width < 300.0:
        raise RuntimeError(f"비정상적인 열 너비가 감지되었습니다: {column_width:.2f}")

    return Layout(
        first_content_page=min(header.page_no for header in headers),
        column_x=column_x,
        column_width=column_width,
    )


def segment_index(header: Header, layout: Layout) -> int:
    return (header.page_no - layout.first_content_page) * 2 + header.column


def segment_location(index: int, layout: Layout) -> tuple[int, int]:
    page_offset, column = divmod(index, 2)
    return layout.first_content_page + page_offset, column


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def trim_vertical(image: Image.Image) -> Image.Image | None:
    gray = ImageOps.grayscale(image)
    mask = gray.point(
        lambda value: 255 if value < NONWHITE_THRESHOLD else 0,
        mode="1",
    )
    bbox = mask.getbbox()
    if bbox is None:
        return None

    top = max(0, bbox[1] - VERTICAL_TRIM_MARGIN_PX)
    bottom = min(image.height, bbox[3] + VERTICAL_TRIM_MARGIN_PX)
    return image.crop((0, top, image.width, bottom))


def join_segments(segments: list[Image.Image]) -> Image.Image:
    if not segments:
        raise RuntimeError("해설 영역이 비어 있습니다.")

    width = max(segment.width for segment in segments)
    height = sum(segment.height for segment in segments)
    height += SEGMENT_JOIN_GAP_PX * (len(segments) - 1)
    result = Image.new("RGB", (width, height), "white")

    y = 0
    for segment in segments:
        result.paste(segment, (0, y))
        y += segment.height + SEGMENT_JOIN_GAP_PX
    return result


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", compress_level=9)


def remove_footer_brand(image: Image.Image, scale: float) -> None:
    """Remove the pale publisher mark without erasing dark solution content."""
    left = max(0, math.floor(FOOTER_BRAND_LEFT_PT * scale))
    top = max(0, math.floor(FOOTER_BRAND_TOP_PT * scale))
    right = min(image.width, math.ceil(FOOTER_BRAND_RIGHT_PT * scale))
    bottom = min(image.height, math.ceil(FOOTER_BRAND_BOTTOM_PT * scale))
    pixels = image.load()

    for y in range(top, bottom):
        for x in range(left, right):
            red, green, blue = pixels[x, y]
            is_teal = (
                red > 90
                and green - red >= 20
                and blue - red >= 25
            )
            is_light_gray = (
                115 <= red <= 254
                and abs(red - green) <= 25
                and abs(red - blue) <= 25
            )
            if is_teal or is_light_gray:
                pixels[x, y] = (255, 255, 255)


def extract(
    document: pymupdf.Document,
    headers: list[Header],
    layout: Layout,
    project_root: Path,
    source_pdf: Path,
    scale: float,
    max_problems: int | None,
) -> dict[str, dict[str, str]]:
    answers_dir = project_root / "images" / "answers"
    solutions_dir = project_root / "images" / "solutions"
    answers_dir.mkdir(parents=True, exist_ok=True)
    solutions_dir.mkdir(parents=True, exist_ok=True)

    selected_headers = headers
    if max_problems is not None:
        if max_problems < 1:
            raise ValueError("--max-problems는 1 이상이어야 합니다.")
        selected_headers = headers[:max_problems]

    @lru_cache(maxsize=3)
    def render_page(page_no: int) -> Image.Image:
        page = document[page_no - 1]
        pixmap = page.get_pixmap(
            matrix=pymupdf.Matrix(scale, scale),
            alpha=False,
        )
        image = Image.frombytes(
            "RGB",
            (pixmap.width, pixmap.height),
            pixmap.samples,
        )
        remove_footer_brand(image, scale)
        return image

    def crop_column(
        page_no: int,
        column: int,
        top_pt: float,
        bottom_pt: float,
    ) -> Image.Image | None:
        if page_no < 1 or page_no > document.page_count:
            return None

        page = document[page_no - 1]
        x0_pt = (
            layout.column_x[(page_no % 2, column)] - COLUMN_SIDE_PAD_PT
        )
        x1_pt = (
            layout.column_x[(page_no % 2, column)]
            + layout.column_width
            + COLUMN_SIDE_PAD_PT
        )
        y0_pt = max(0.0, top_pt)
        y1_pt = min(page.rect.height, bottom_pt)
        if y1_pt - y0_pt < 1.0:
            return None

        source = render_page(page_no)
        left = max(0, math.floor(x0_pt * scale))
        top = max(0, math.floor(y0_pt * scale))
        right = min(source.width, math.ceil(x1_pt * scale))
        bottom = min(source.height, math.ceil(y1_pt * scale))
        return source.crop((left, top, right, bottom))

    data: dict[str, dict[str, str]] = {}
    final_segment = (
        document.page_count - layout.first_content_page
    ) * 2 + 1

    for index, header in enumerate(selected_headers):
        number = header.number
        number_padded = f"{number:03d}"

        answer = crop_column(
            header.page_no,
            header.column,
            header.y0 - HEADER_TOP_PAD_PT,
            header.y1 + HEADER_BOTTOM_PAD_PT,
        )
        if answer is None:
            raise RuntimeError(f"{number_padded}번 정답 영역을 만들 수 없습니다.")
        answer = trim_vertical(answer) or answer

        # Use the next header from the complete list even during a limited test
        # run, so the final selected solution still ends at the correct place.
        absolute_index = index
        next_header = (
            headers[absolute_index + 1]
            if absolute_index + 1 < len(headers)
            else None
        )
        start_segment = segment_index(header, layout)
        end_segment = (
            segment_index(next_header, layout)
            if next_header is not None
            else final_segment
        )

        solution_segments: list[Image.Image] = []
        for current_segment in range(start_segment, end_segment + 1):
            page_no, column = segment_location(current_segment, layout)
            top_pt = (
                header.y1 + SOLUTION_TOP_PAD_PT
                if current_segment == start_segment
                else CONTENT_TOP_PT
            )
            bottom_pt = CONTENT_BOTTOM_PT
            if next_header is not None and current_segment == end_segment:
                bottom_pt = next_header.y0 - NEXT_HEADER_GAP_PT

            segment = crop_column(page_no, column, top_pt, bottom_pt)
            if segment is None:
                continue
            segment = trim_vertical(segment)
            if segment is not None:
                solution_segments.append(segment)

        if not solution_segments:
            raise RuntimeError(f"{number_padded}번 해설 영역이 비어 있습니다.")

        solution = join_segments(solution_segments)
        answer_rel = Path("images") / "answers" / f"ans_{number_padded}.png"
        solution_rel = (
            Path("images") / "solutions" / f"sol_{number_padded}.png"
        )
        save_png(answer, project_root / answer_rel)
        save_png(solution, project_root / solution_rel)

        data[str(number)] = {
            "answer_url": answer_rel.as_posix(),
            "solution_url": solution_rel.as_posix(),
        }

        if index == 0 or (index + 1) % 50 == 0 or index + 1 == len(selected_headers):
            print(
                f"[{index + 1:>3}/{len(selected_headers)}] "
                f"{number_padded}번 추출 완료"
            )

    data_path = project_root / "data.json"
    data_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    report_dir = project_root / "output" / "pdf"
    report_dir.mkdir(parents=True, exist_ok=True)
    try:
        source_label = source_pdf.relative_to(project_root).as_posix()
    except ValueError:
        source_label = source_pdf.as_posix()
    report = {
        "source_pdf": source_label,
        "source_sha256": sha256_file(source_pdf),
        "page_count": document.page_count,
        "detected_problem_count": len(headers),
        "extracted_problem_count": len(selected_headers),
        "first_problem": selected_headers[0].number,
        "last_problem": selected_headers[-1].number,
        "render_scale": scale,
        "answer_directory": "images/answers",
        "solution_directory": "images/solutions",
        "data_file": "data.json",
    }
    (report_dir / "extraction-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return data


def main() -> int:
    args = parse_args()
    project_root = args.project_root.resolve()
    source_pdf = (
        args.pdf
        if args.pdf.is_absolute()
        else (project_root / args.pdf)
    ).resolve()

    if not source_pdf.is_file():
        print(f"PDF를 찾을 수 없습니다: {source_pdf}", file=sys.stderr)
        return 1
    if args.scale <= 0:
        print("--scale은 0보다 커야 합니다.", file=sys.stderr)
        return 1

    try:
        document = pymupdf.open(source_pdf)
        headers = find_headers(document)
        layout = infer_layout(document, headers)
        print(
            f"{document.page_count}페이지에서 "
            f"{headers[0].number:03d}-{headers[-1].number:03d}, "
            f"총 {len(headers)}문항을 감지했습니다."
        )
        extract(
            document=document,
            headers=headers,
            layout=layout,
            project_root=project_root,
            source_pdf=source_pdf,
            scale=args.scale,
            max_problems=args.max_problems,
        )
    except Exception as error:
        print(f"추출 실패: {error}", file=sys.stderr)
        return 1

    print("정답 이미지, 해설 이미지, data.json 생성을 완료했습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
