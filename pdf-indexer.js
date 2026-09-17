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
const OLYMPUS_CONTENT_TOP_PT = 65;
const OLYMPUS_CONTENT_BOTTOM_PT = 800;
const OLYMPUS_HEADER_MIN_HEIGHT_PT = 13;
const OLYMPUS_HEADER_MAX_HEIGHT_PT = 15;
const OLYMPUS_COLUMN_GAP_PT = 16;

const OLYMPUS_CATEGORIES = {
  concept: "개념 확인하기",
  type: "유형 완성하기",
  written: "서술형 완성하기",
  challenge: "내신 + 수능 고난도 도전",
};

function median(values) {
  if (!values.length) {
    throw new Error("레이아웃 표본이 없습니다.");
  }
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function describePageError(error) {
  if (error === null) {
    return "null 오류";
  }
  if (error === undefined) {
    return "undefined 오류";
  }
  const name =
    typeof error.name === "string" && error.name !== "Error"
      ? `${error.name}: `
      : "";
  const message =
    typeof error.message === "string" ? error.message : String(error);
  return `${name}${message || "알 수 없는 오류"}`;
}

function readingIndex(item) {
  return (item.pageNumber - 1) * 2 + item.column;
}

function compareReadingOrder(left, right) {
  return readingIndex(left) - readingIndex(right) || left.top - right.top;
}

function isBefore(left, right) {
  return compareReadingOrder(left, right) < 0;
}

function findOlympusRuns(candidates) {
  const runs = [];

  candidates.forEach((candidate) => {
    if (candidate.number === 1) {
      runs.push([candidate]);
      return;
    }

    const run = runs[runs.length - 1];
    if (run && candidate.number === run[run.length - 1].number + 1) {
      run.push(candidate);
    }
  });

  return runs.filter((run) => run.length >= 3);
}

function inferOlympusLayout(headers, pageWidths) {
  const samples = new Map([
    ["0:0", []],
    ["0:1", []],
    ["1:0", []],
    ["1:1", []],
  ]);

  headers.forEach((header) => {
    samples.get(`${header.pageNumber % 2}:${header.column}`).push(header.x);
  });

  const columnX = {};
  for (const [key, values] of samples) {
    if (!values.length) {
      throw new Error(`올림포스 2단 위치 표본이 부족합니다: ${key}`);
    }
    columnX[key] = median(values);
  }

  const columnStep = median([
    columnX["0:1"] - columnX["0:0"],
    columnX["1:1"] - columnX["1:0"],
  ]);

  return {
    columnX,
    columnWidth: columnStep - OLYMPUS_COLUMN_GAP_PT,
    pageWidth: median(pageWidths),
  };
}

function buildOlympusIndex({
  candidates,
  categoryMarkers,
  unitMarkers,
  pageItems,
  pageWidths,
  pageHeights,
  pageCount,
  sourceHash,
  fileName,
}) {
  candidates.sort(compareReadingOrder);
  categoryMarkers.sort(compareReadingOrder);
  unitMarkers.sort(compareReadingOrder);

  const runs = findOlympusRuns(candidates);
  if (runs.length < 4 || !unitMarkers.length || !categoryMarkers.length) {
    throw new Error(
      `올림포스 문항 묶음을 찾지 못했습니다. 단원 ${unitMarkers.length}개, 유형 ${categoryMarkers.length}개, 풀이 묶음 ${runs.length}개`,
    );
  }

  const allHeaders = runs.flat();
  const layout = inferOlympusLayout(allHeaders, pageWidths);
  const allAnswerMarks = Array.from(pageItems.values())
    .flat()
    .filter((item) => item.text === "")
    .sort(compareReadingOrder);

  function cropSpec(pageNumber, column, top, bottom, xStart = null) {
    const pageHeight = pageHeights.get(pageNumber);
    const columnStart = layout.columnX[`${pageNumber % 2}:${column}`];
    const x0 = (xStart ?? columnStart) - COLUMN_SIDE_PAD_PT;
    const x1 = Math.min(
      layout.pageWidth,
      columnStart + layout.columnWidth + COLUMN_SIDE_PAD_PT,
    );
    const y0 = Math.max(0, top);
    const y1 = Math.min(pageHeight, bottom);
    if (y1 - y0 < 1 || x1 - x0 < 1) {
      return null;
    }
    return {
      page: pageNumber,
      rect: [x0, y0, x1, y1].map(rounded),
    };
  }

  function segmentLocation(index) {
    return {
      pageNumber: Math.floor(index / 2) + 1,
      column: index % 2,
    };
  }

  const sections = runs.map((headers, runIndex) => {
    const firstHeader = headers[0];
    const unit = unitMarkers
      .filter((marker) => isBefore(marker, firstHeader))
      .slice(-1)[0];
    const category = categoryMarkers
      .filter((marker) => isBefore(marker, firstHeader))
      .slice(-1)[0];

    if (!unit || !category) {
      throw new Error(`${firstHeader.pageNumber}쪽 문항 묶음의 단원 정보를 찾지 못했습니다.`);
    }

    const nextCategory = categoryMarkers.find((marker) =>
      isBefore(headers[headers.length - 1], marker),
    );
    const problems = {};

    headers.forEach((header, headerIndex) => {
      const nextHeader = headers[headerIndex + 1] || null;
      const boundary = nextHeader || nextCategory || null;
      const startSegment = readingIndex(header);
      const endSegment = boundary
        ? readingIndex(boundary)
        : (pageCount - 1) * 2 + 1;
      const solution = [];

      for (
        let currentSegment = startSegment;
        currentSegment <= endSegment;
        currentSegment += 1
      ) {
        const location = segmentLocation(currentSegment);
        const top =
          currentSegment === startSegment
            ? header.top - 2
            : OLYMPUS_CONTENT_TOP_PT;
        const bottom =
          boundary && currentSegment === endSegment
            ? boundary.top - 5
            : OLYMPUS_CONTENT_BOTTOM_PT;
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

      const answerMark = allAnswerMarks
        .filter(
          (item) =>
            !isBefore(item, header) &&
            (!boundary || isBefore(item, boundary)),
        )
        .slice(-1)[0];
      if (!answerMark || !solution.length) {
        throw new Error(
          `${unit.number}단원 ${category.label} ${header.number}번 영역을 만들 수 없습니다.`,
        );
      }

      const answer = cropSpec(
        answerMark.pageNumber,
        answerMark.column,
        answerMark.top - 2,
        answerMark.baseline + 5,
        answerMark.x - 4,
      );
      problems[String(header.number)] = {
        answer: [answer],
        solution,
      };
    });

    return {
      id: `olympus-${unit.number}-${category.id}`,
      order: runIndex,
      unit_id: unit.number,
      unit_title: unit.title,
      category_id: category.id,
      category_label: category.label,
      number_width: 2,
      range: {
        first: headers[0].number,
        last: headers[headers.length - 1].number,
        count: headers.length,
      },
      problems,
    };
  });

  return {
    schema_version: 2,
    source: {
      sha256: sourceHash,
      page_count: pageCount,
      file_name: fileName,
    },
    range: {
      first: 1,
      last: Math.max(...sections.map((section) => section.range.last)),
      count: sections.reduce((total, section) => total + section.range.count, 0),
    },
    render: {
      scale: 2,
      nonwhite_threshold: 248,
      vertical_trim_margin_px: 10,
      segment_join_gap_px: 14,
      footer_brand_rect: [0, 0, 0, 0],
    },
    analyzer: {
      type: "olympus-two-column-v1",
      candidate_count: candidates.length,
      section_count: sections.length,
    },
    default_section_id:
      sections.find((section) => section.category_id === "type")?.id ||
      sections[0].id,
    sections,
  };
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

  const sampleEntries = Array.from(samples.entries());
  const missing = sampleEntries
    .filter(([, values]) => !values.length)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`2단 위치 표본이 부족합니다: ${missing.join(", ")}`);
  }

  const columnX = {};
  sampleEntries.forEach(([key, values]) => {
    columnX[key] = median(values);
  });
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
    firstContentPage: headers.reduce(
      (first, header) => Math.min(first, header.pageNumber),
      headers[0].pageNumber,
    ),
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
  const olympusCandidates = [];
  const olympusCategoryMarkers = [];
  const olympusUnitMarkers = [];
  const pageItems = new Map();
  const pageWidths = [];
  const pageHeights = new Map();
  const progressInterval = Math.max(10, Math.ceil(pdfDocument.numPages / 8));

  for (
    let pageNumber = 1;
    pageNumber <= pdfDocument.numPages;
    pageNumber += 1
  ) {
    let page;
    let viewport;
    let textContent;
    try {
      page = await pdfDocument.getPage(pageNumber);
      viewport = page.getViewport({ scale: 1 });
      textContent = await page.getTextContent();
    } catch (error) {
      throw new Error(
        `${pageNumber}/${pdfDocument.numPages}쪽 텍스트 읽기 실패 · ${describePageError(error)}`,
      );
    }
    pageWidths.push(viewport.width);
    pageHeights.set(pageNumber, viewport.height);

    const transformedItems = textContent.items
      .map((item) => {
        const text = item.str.trim();
        if (!text) {
          return null;
        }
      const transform = Util.transform(viewport.transform, item.transform);
      const height = Math.hypot(transform[2], transform[3]);
      const baseline = transform[5];
      const top = baseline - height;
        return {
          text,
          pageNumber,
          column: transform[4] < viewport.width / 2 ? 0 : 1,
          x: transform[4],
          top,
          baseline,
          height,
        };
      })
      .filter(Boolean);
    pageItems.set(pageNumber, transformedItems);

    transformedItems.forEach((item) => {
      if (/^\d{3}$/.test(item.text)) {
      if (
          item.height >= MIN_HEADER_HEIGHT_PT &&
          item.height <= MAX_HEADER_HEIGHT_PT &&
          item.top < CONTENT_BOTTOM_PT
      ) {
          candidates.push({
            number: Number(item.text),
            pageNumber,
            column: item.column,
            x: item.x,
            top: item.top,
            baseline: item.baseline,
            height: item.height,
          });
        }
      }

      if (
        /^\d{2}$/.test(item.text) &&
        item.height >= OLYMPUS_HEADER_MIN_HEIGHT_PT &&
        item.height <= OLYMPUS_HEADER_MAX_HEIGHT_PT &&
        item.top < OLYMPUS_CONTENT_BOTTOM_PT &&
        (item.x < 110 || (item.x > 300 && item.x < 390))
      ) {
        olympusCandidates.push({
          ...item,
          number: Number(item.text),
        });
      }

      let categoryId = null;
      if (item.text === OLYMPUS_CATEGORIES.concept) {
        categoryId = "concept";
      } else if (item.text === OLYMPUS_CATEGORIES.type) {
        categoryId = "type";
      } else if (item.text === OLYMPUS_CATEGORIES.written) {
        categoryId = "written";
      } else if (item.text === "내신") {
        categoryId = "challenge";
      }
      if (categoryId) {
        olympusCategoryMarkers.push({
          ...item,
          id: categoryId,
          label: OLYMPUS_CATEGORIES[categoryId],
        });
      }
    });

    const unitNumbers = transformedItems.filter(
      (item) =>
        /^0[1-9]$/.test(item.text) &&
        item.height >= 15.5 &&
        item.height <= 16.5 &&
        (item.x < 110 || (item.x > 300 && item.x < 390)) &&
        item.top < 180,
    );
    unitNumbers.forEach((marker) => {
      const title = transformedItems
        .filter(
          (item) =>
            item.x > marker.x &&
            item.x <
              (marker.column === 0 ? viewport.width / 2 : viewport.width) &&
            Math.abs(item.baseline - marker.baseline) < 5 &&
            item.height >= 12,
        )
        .sort((left, right) => left.x - right.x)[0];
      if (title) {
        olympusUnitMarkers.push({
          ...marker,
          number: marker.text,
          title: title.text,
        });
      }
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
    return buildOlympusIndex({
      candidates: olympusCandidates,
      categoryMarkers: olympusCategoryMarkers,
      unitMarkers: olympusUnitMarkers,
      pageItems,
      pageWidths,
      pageHeights,
      pageCount: pdfDocument.numPages,
      sourceHash,
      fileName,
    });
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
      last: headers[headers.length - 1].number,
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
