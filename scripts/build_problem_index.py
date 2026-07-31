#!/usr/bin/env python3
"""Build compact crop metadata for browser-side, on-demand PDF rendering."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pymupdf

from extract_answer_images import (
    COLUMN_SIDE_PAD_PT,
    CONTENT_BOTTOM_PT,
    CONTENT_TOP_PT,
    FOOTER_BRAND_BOTTOM_PT,
    FOOTER_BRAND_LEFT_PT,
    FOOTER_BRAND_RIGHT_PT,
    FOOTER_BRAND_TOP_PT,
    HEADER_BOTTOM_PAD_PT,
    HEADER_TOP_PAD_PT,
    NEXT_HEADER_GAP_PT,
    NONWHITE_THRESHOLD,
    SEGMENT_JOIN_GAP_PX,
    SOLUTION_TOP_PAD_PT,
    VERTICAL_TRIM_MARGIN_PX,
    find_headers,
    infer_layout,
    segment_index,
    segment_location,
    sha256_file,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create problem-index.json for on-demand browser rendering."
    )
    parser.add_argument(
        "--pdf",
        type=Path,
        default=Path("answer_sheets/gojangee_gongsutwo.pdf"),
        help="Source PDF path.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("problem-index.json"),
        help="Output JSON path.",
    )
    return parser.parse_args()


def rounded_rect(values: tuple[float, float, float, float]) -> list[float]:
    return [round(value, 3) for value in values]


def main() -> int:
    args = parse_args()
    pdf_path = args.pdf.resolve()
    output_path = args.output.resolve()

    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF를 찾을 수 없습니다: {pdf_path}")

    document = pymupdf.open(pdf_path)
    headers = find_headers(document)
    layout = infer_layout(document, headers)
    final_segment = (
        document.page_count - layout.first_content_page
    ) * 2 + 1

    def crop_spec(
        page_no: int,
        column: int,
        top_pt: float,
        bottom_pt: float,
    ) -> dict[str, int | list[float]] | None:
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

        return {
            "page": page_no,
            "rect": rounded_rect((x0_pt, y0_pt, x1_pt, y1_pt)),
        }

    problems: dict[str, dict[str, list[dict[str, int | list[float]]]]] = {}
    for index, header in enumerate(headers):
        answer = crop_spec(
            header.page_no,
            header.column,
            header.y0 - HEADER_TOP_PAD_PT,
            header.y1 + HEADER_BOTTOM_PAD_PT,
        )
        if answer is None:
            raise RuntimeError(f"{header.number:03d}번 정답 영역이 비어 있습니다.")

        next_header = headers[index + 1] if index + 1 < len(headers) else None
        start_segment = segment_index(header, layout)
        end_segment = (
            segment_index(next_header, layout)
            if next_header is not None
            else final_segment
        )

        solution: list[dict[str, int | list[float]]] = []
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

            segment = crop_spec(page_no, column, top_pt, bottom_pt)
            if segment is not None:
                solution.append(segment)

        if not solution:
            raise RuntimeError(f"{header.number:03d}번 해설 영역이 비어 있습니다.")

        problems[str(header.number)] = {
            "answer": [answer],
            "solution": solution,
        }

    index_data = {
        "schema_version": 1,
        "source": {
            "url": "./gojangee_gongsutwo.pdf",
            "sha256": sha256_file(pdf_path),
            "page_count": document.page_count,
        },
        "range": {
            "first": headers[0].number,
            "last": headers[-1].number,
            "count": len(headers),
        },
        "render": {
            "scale": 2.0,
            "nonwhite_threshold": NONWHITE_THRESHOLD,
            "vertical_trim_margin_px": VERTICAL_TRIM_MARGIN_PX,
            "segment_join_gap_px": SEGMENT_JOIN_GAP_PX,
            "footer_brand_rect": [
                FOOTER_BRAND_LEFT_PT,
                FOOTER_BRAND_TOP_PT,
                FOOTER_BRAND_RIGHT_PT,
                FOOTER_BRAND_BOTTOM_PT,
            ],
        },
        "problems": problems,
    }

    output_path.write_text(
        json.dumps(index_data, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"{headers[0].number:03d}-{headers[-1].number:03d} "
        f"총 {len(headers)}문항 좌표를 {output_path}에 저장했습니다."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
