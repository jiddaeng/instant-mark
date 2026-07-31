const CONTENT_TOP_PT = 32;
const CONTENT_BOTTOM_PT = 800;
const COLUMN_SIDE_PAD_PT = 3;
const ANSWER_TOP_FROM_TEXT_TOP_PT = 1;
const ANSWER_BOTTOM_FROM_BASELINE_PT = 8;
const SOLUTION_TOP_FROM_BASELINE_PT = 6;
const NEXT_HEADER_GAP_FROM_TEXT_TOP_PT = 4;
const MIN_HEADER_HEIGHT_PT = 16;
const MAX_HEADER_HEIGHT_PT = 24;
const MIN_PROBLEM_COUNT = 10;

function median(values) {
  if (!values.length) {
    throw new Error("레이아웃 표본이 없습니다.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function findLongestProblemRun(candidates) {
  let best = [];

  candidates.forEach((candidate, startIndex) => {
    if (candidate.number !== 1) {
      return;
    }

    const run = [candidate];
    let expected = 2;
    for (let index = startIndex + 1; index < candidates.length; index += 1) {
      if (candidates[index].number === expected) {
        run.push(candidates[index]);
        expected += 1;
      }
    }

    if (run.length > best.length) {
      best = run;
    }
  });

  return best;
}

function inferLayout(headers, pageWidths) {
  const samples = new Map([
    ["0:0", []],
    ["0:1", []],
    ["1:0", []],
    ["1:1", []],
  ]);

  headers.forEach((header) => {
    samples.get(`${header.pageNumber % 2}:${header.column}`).push(header.x);
  });

  const missing = [...samples.entries()]
    .filter(([, values]) => !values.length)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`2단 위치 표본이 부족합니다: ${missing.join(", ")}`);
  }

  const columnX = Object.fromEntries(
    [...samples.entries()].map(([key, values]) => [key, median(values)]),
  );
  const pageWidth = median(pageWidths);
  const columnStep = median([
    columnX["0:1"] - columnX["0:0"],
    columnX["1:1"] - columnX["1:0"],
  ]);
  const columnWidth =
    pageWidth - columnX["0:0"] - columnX["1:0"] - columnStep;

  if (columnWidth < 200 || columnWidth > 300) {
    throw new Error(
      `예상한 고쟁이 2단 너비가 아닙니다: ${columnWidth.toFixed(1)}pt`,
    );
  }

  return {
    firstContentPage: Math.min(...headers.map((header) => header.pageNumber)),
    columnX,
    columnWidth,
  };
}

function segmentIndex(header, layout) {
  return (
    (header.pageNumber - layout.firstContentPage) * 2 + header.column
  );
}

function segmentLocation(index, layout) {
  const pageOffset = Math.floor(index / 2);
  return {
    pageNumber: layout.firstContentPage + pageOffset,
    column: index % 2,
  };
}

export async function analyzeGojangeePdf({
  pdfDocument,
  Util,
  sourceHash,
  fileName,
  onProgress = () => {},
}) {
  const candidates = [];
  const pageWidths = [];
  const pageHeights = new Map();
  const progressInterval = Math.max(10, Math.ceil(pdfDocument.numPages / 8));

  for (
    let pageNumber = 1;
    pageNumber <= pdfDocument.numPages;
    pageNumber += 1
  ) {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    pageWidths.push(viewport.width);
    pageHeights.set(pageNumber, viewport.height);

    textContent.items.forEach((item) => {
      const text = item.str.trim();
      if (!/^\d{3}$/.test(text)) {
        return;
      }

      const transform = Util.transform(viewport.transform, item.transform);
      const height = Math.hypot(transform[2], transform[3]);
      const baseline = transform[5];
      const top = baseline - height;
      if (
        height < MIN_HEADER_HEIGHT_PT ||
        height > MAX_HEADER_HEIGHT_PT ||
        top >= CONTENT_BOTTOM_PT
      ) {
        return;
      }

      candidates.push({
        number: Number(text),
        pageNumber,
        column: transform[4] < viewport.width / 2 ? 0 : 1,
        x: transform[4],
        top,
        baseline,
        height,
      });
    });

    if (
      pageNumber === 1 ||
      pageNumber === pdfDocument.numPages ||
      pageNumber % progressInterval === 0
    ) {
      onProgress({
        pageNumber,
        pageCount: pdfDocument.numPages,
        candidateCount: candidates.length,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.pageNumber - right.pageNumber ||
      left.column - right.column ||
      left.top - right.top,
  );
  const headers = findLongestProblemRun(candidates);
  if (headers.length < MIN_PROBLEM_COUNT) {
    throw new Error(
      `연속 문항 머리표를 충분히 찾지 못했습니다. 후보 ${candidates.length}개, 연결 ${headers.length}개`,
    );
  }

  const layout = inferLayout(headers, pageWidths);
  const finalSegment =
    (pdfDocument.numPages - layout.firstContentPage) * 2 + 1;

  function cropSpec(pageNumber, column, top, bottom) {
    if (pageNumber < 1 || pageNumber > pdfDocument.numPages) {
      return null;
    }

    const pageHeight = pageHeights.get(pageNumber);
    const x0 =
      layout.columnX[`${pageNumber % 2}:${column}`] -
      COLUMN_SIDE_PAD_PT;
    const x1 =
      layout.columnX[`${pageNumber % 2}:${column}`] +
      layout.columnWidth +
      COLUMN_SIDE_PAD_PT;
    const y0 = Math.max(0, top);
    const y1 = Math.min(pageHeight, bottom);
    if (y1 - y0 < 1) {
      return null;
    }

    return {
      page: pageNumber,
      rect: [x0, y0, x1, y1].map(rounded),
    };
  }

  const problems = {};
  headers.forEach((header, index) => {
    const nextHeader = headers[index + 1] || null;
    const answer = cropSpec(
      header.pageNumber,
      header.column,
      header.top - ANSWER_TOP_FROM_TEXT_TOP_PT,
      header.baseline + ANSWER_BOTTOM_FROM_BASELINE_PT,
    );
    if (!answer) {
      throw new Error(`${header.number}번 정답 영역을 만들 수 없습니다.`);
    }

    const startSegment = segmentIndex(header, layout);
    const endSegment = nextHeader
      ? segmentIndex(nextHeader, layout)
      : finalSegment;
    const solution = [];

    for (
      let currentSegment = startSegment;
      currentSegment <= endSegment;
      currentSegment += 1
    ) {
      const location = segmentLocation(currentSegment, layout);
      const top =
        currentSegment === startSegment
          ? header.baseline + SOLUTION_TOP_FROM_BASELINE_PT
          : CONTENT_TOP_PT;
      const bottom =
        nextHeader && currentSegment === endSegment
          ? nextHeader.top - NEXT_HEADER_GAP_FROM_TEXT_TOP_PT
          : CONTENT_BOTTOM_PT;
      const segment = cropSpec(
        location.pageNumber,
        location.column,
        top,
        bottom,
      );
      if (segment) {
        solution.push(segment);
      }
    }

    if (!solution.length) {
      throw new Error(`${header.number}번 해설 영역을 만들 수 없습니다.`);
    }

    problems[String(header.number)] = {
      answer: [answer],
      solution,
    };
  });

  return {
    schema_version: 1,
    source: {
      sha256: sourceHash,
      page_count: pdfDocument.numPages,
      file_name: fileName,
    },
    range: {
      first: headers[0].number,
      last: headers.at(-1).number,
      count: headers.length,
    },
    render: {
      scale: 2,
      nonwhite_threshold: 248,
      vertical_trim_margin_px: 10,
      segment_join_gap_px: 14,
      footer_brand_rect: [275, 785, 377, 807],
    },
    analyzer: {
      type: "gojangee-two-column-v1",
      candidate_count: candidates.length,
      header_height: rounded(median(headers.map((header) => header.height))),
      column_width: rounded(layout.columnWidth),
    },
    problems,
  };
}
