import problemIndex from "./problem-index.json";
import {
  deleteStoredBook,
  listStoredBooks,
  saveStoredBook,
} from "./book-library.js";
import { analyzeGojangeePdf } from "./pdf-indexer.js";

const RENDERER_VERSION = 1;
const PDF_ANALYZER_VERSION = 2;
const APP_BUILD = "2026.07.31-ios-pdf2";
const CACHE_DB_NAME = "gojangee-render-cache";
const CACHE_STORE_NAME = "problem-images";
const DEFAULT_BOOK_ID = "builtin-gojangee";
const ACTIVE_BOOK_STORAGE_KEY = "instant-mark-active-book";
const MAX_MEMORY_IMAGES = 12;
const MAX_RENDERED_PAGES = 2;

const defaultBook = {
  id: DEFAULT_BOOK_ID,
  title: "고쟁이 공통수학 2",
  fileName: "gojangee_gongsutwo.pdf",
  pageCount: problemIndex.source.page_count,
  sha256: problemIndex.source.sha256,
  blob: null,
  index: problemIndex,
  builtIn: true,
};
const books = new Map([[DEFAULT_BOOK_ID, defaultBook]]);

const elements = {
  bookPanel: document.querySelector("#book-panel"),
  connectionPanel: document.querySelector("#connection-panel"),
  activeBookName: document.querySelector("#active-book-name"),
  bookSelect: document.querySelector("#book-select"),
  addBookButton: document.querySelector("#add-book-button"),
  bookFileInput: document.querySelector("#book-file-input"),
  bookMessage: document.querySelector("#book-message"),
  openBookButton: document.querySelector("#open-book-button"),
  analyzeBookButton: document.querySelector("#analyze-book-button"),
  removeBookButton: document.querySelector("#remove-book-button"),
  connectionLogList: document.querySelector("#connection-log-list"),
  connectionLogStatus: document.querySelector("#connection-log-status"),
  form: document.querySelector("#problem-form"),
  input: document.querySelector("#problem-number"),
  decrementButton: document.querySelector("#decrement-button"),
  incrementButton: document.querySelector("#increment-button"),
  keypadToggle: document.querySelector("#keypad-toggle"),
  keypad: document.querySelector("#number-keypad"),
  keypadKeys: document.querySelectorAll(".keypad-key"),
  submitButton: document.querySelector("#submit-button"),
  formMessage: document.querySelector("#form-message"),
  rangeBadge: document.querySelector("#range-badge"),
  resultSection: document.querySelector("#result-section"),
  resultNumber: document.querySelector("#result-number"),
  answerMedia: document.querySelector("#answer-media"),
  answerImage: document.querySelector("#answer-image"),
  answerError: document.querySelector("#answer-error"),
  solutionToggle: document.querySelector("#solution-toggle"),
  solutionToggleText: document.querySelector("#solution-toggle-text"),
  solutionPanel: document.querySelector("#solution-panel"),
  solutionMedia: document.querySelector("#solution-media"),
  solutionImage: document.querySelector("#solution-image"),
  solutionError: document.querySelector("#solution-error"),
};

const mediaElements = {
  answer: {
    container: elements.answerMedia,
    image: elements.answerImage,
    error: elements.answerError,
  },
  solution: {
    container: elements.solutionMedia,
    image: elements.solutionImage,
    error: elements.solutionError,
  },
};

const memoryImageCache = new Map();
const imageRequests = new Map();
const renderedPageCache = new Map();
const imageRequestTokens = { answer: 0, solution: 0 };
const objectUrls = { answer: null, solution: null };
const analysisInFlight = new Map();
const autoAnalysisAttempted = new Set();

let activeProblem = null;
let solutionLoadedFor = null;
let formEnabled = false;
let activeBook = defaultBook;
let activeBookRevision = 0;
let firstProblem = problemIndex.range.first;
let lastProblem = problemIndex.range.last;
let pdfLibraryPromise = null;
let pdfDocumentState = { bookId: null, promise: null };
let cacheDatabasePromise = null;

function isCoarsePointer() {
  return window.matchMedia("(pointer: coarse)").matches;
}

function openUtilityPanel(panel) {
  elements.bookPanel.open = panel === elements.bookPanel;
  elements.connectionPanel.open =
    panel === elements.connectionPanel;
}

function setConnectionStatus(label, state = "idle") {
  elements.connectionLogStatus.textContent = label;
  elements.connectionLogStatus.classList.toggle(
    "is-working",
    state === "working",
  );
  elements.connectionLogStatus.classList.toggle(
    "is-error",
    state === "error",
  );
}

function addConnectionLog(message, level = "info") {
  const item = document.createElement("li");
  item.textContent = message;
  item.dataset.level = level;
  elements.connectionLogList.append(item);

  while (elements.connectionLogList.children.length > 60) {
    elements.connectionLogList.firstElementChild.remove();
  }
  elements.connectionLogList.scrollTop =
    elements.connectionLogList.scrollHeight;
}

function setBookMessage(message, isError = false) {
  elements.bookMessage.textContent = message;
  elements.bookMessage.classList.toggle("is-error", isError);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getBookIndex(book = activeBook) {
  return book?.index || null;
}

function renderBookOptions() {
  const selectedId = activeBook?.id || DEFAULT_BOOK_ID;
  const fragment = document.createDocumentFragment();

  [...books.values()]
    .sort((left, right) => {
      if (left.builtIn) {
        return -1;
      }
      if (right.builtIn) {
        return 1;
      }
      return (right.addedAt || 0) - (left.addedAt || 0);
    })
    .forEach((book) => {
      const option = document.createElement("option");
      option.value = book.id;
      option.textContent = book.builtIn
        ? `기본 · ${book.title}`
        : book.title;
      fragment.append(option);
    });

  elements.bookSelect.replaceChildren(fragment);
  elements.bookSelect.value = books.has(selectedId)
    ? selectedId
    : DEFAULT_BOOK_ID;
  elements.bookSelect.disabled = false;
}

function resetPdfDocument() {
  const previousPromise = pdfDocumentState.promise;
  pdfDocumentState = { bookId: null, promise: null };
  renderedPageCache.clear();

  if (previousPromise) {
    void previousPromise
      .then((pdfDocument) => pdfDocument.destroy())
      .catch(() => {});
  }
}

function resetProblemView() {
  activeBookRevision += 1;
  activeProblem = null;
  solutionLoadedFor = null;
  setKeypadOpen(false);
  setMessage();
  elements.input.value = "";
  elements.resultSection.hidden = true;
  clearMediaImage("answer");
  resetSolution();
  updateStepButtons();
}

function activateBook(book, { persist = true } = {}) {
  if (!book) {
    return;
  }

  resetPdfDocument();
  resetProblemView();
  activeBook = book;
  elements.bookSelect.value = book.id;
  elements.activeBookName.textContent = book.title;
  elements.removeBookButton.hidden = book.builtIn;

  const index = getBookIndex(book);
  elements.analyzeBookButton.hidden = book.builtIn;
  elements.analyzeBookButton.textContent = index ? "재분석" : "연결 시도";
  if (index) {
    firstProblem = index.range.first;
    lastProblem = index.range.last;
    elements.rangeBadge.textContent = `${firstProblem}—${lastProblem}`;
    elements.form.hidden = false;
    setFormEnabled(true);
    setBookMessage(
      book.builtIn
        ? "기본 답지"
        : `${book.pageCount}쪽 · 이 기기에 저장됨 · 문항 검색 가능`,
    );
    setConnectionStatus("연결 완료");
    addConnectionLog(
      `${
        book.builtIn
          ? "기본"
          : book.indexSource === "built-in-recovery"
            ? "동일한 기본 PDF의 내장"
            : "저장된"
      } 연결 정보 사용: ${index.range.first}–${index.range.last}, ${index.range.count}문항`,
      "success",
    );
  } else {
    firstProblem = 1;
    lastProblem = 1;
    elements.rangeBadge.textContent = `${book.pageCount}쪽`;
    elements.form.hidden = true;
    setFormEnabled(false);
    setBookMessage(
      `${book.pageCount}쪽 · ${formatFileSize(book.size)} · 이 기기에 저장됨 · 문항 검색 연결 전`,
    );
    setConnectionStatus("미연결", "error");
    const needsAutomaticAnalysis =
      !book.analysisAttemptedAt ||
      book.analysisVersion !== PDF_ANALYZER_VERSION;
    if (
      needsAutomaticAnalysis &&
      !autoAnalysisAttempted.has(book.id)
    ) {
      window.requestAnimationFrame(() => {
        void connectStoredBook(book);
      });
    } else if (
      book.analysisMessage &&
      !autoAnalysisAttempted.has(book.id)
    ) {
      addConnectionLog(
        `이전 연결 실패: ${book.analysisMessage}`,
        "error",
      );
    }
  }

  if (persist) {
    try {
      localStorage.setItem(ACTIVE_BOOK_STORAGE_KEY, book.id);
    } catch {
      // The library still works when localStorage is unavailable.
    }
  }
}

function normalizeStoredBook(record) {
  const usesBuiltInIndex =
    !record.problemIndex &&
    record.sha256 === problemIndex.source.sha256;
  return {
    ...record,
    builtIn: false,
    index:
      record.problemIndex ||
      (usesBuiltInIndex ? problemIndex : null),
    indexSource: record.problemIndex
      ? "analyzed"
      : usesBuiltInIndex
        ? "built-in-recovery"
        : null,
  };
}

function toStoredBookRecord(book) {
  const {
    builtIn: _builtIn,
    index,
    indexSource,
    ...record
  } = book;
  return {
    ...record,
    problemIndex:
      indexSource === "built-in-recovery"
        ? null
        : index || record.problemIndex || null,
  };
}

async function sha256Hex(buffer) {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return null;
  }
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  const parts = new Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    parts[index] = bytes[index].toString(16).padStart(2, "0");
  }
  return parts.join("");
}

function readBlobAsArrayBuffer(blob) {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => {
      reject(reader.error || new Error("파일을 읽을 수 없습니다."));
    };
    reader.onabort = () => reject(new Error("파일 읽기가 취소되었습니다."));
    reader.readAsArrayBuffer(blob);
  });
}

function describeError(error) {
  if (error === null) {
    return "null 오류";
  }
  if (error === undefined) {
    return "undefined 오류";
  }

  const name =
    typeof error.name === "string" && error.name !== "Error"
      ? error.name.trim()
      : "";
  const message =
    typeof error.message === "string"
      ? error.message.trim()
      : String(error);
  return name && !message.startsWith(name)
    ? `${name}: ${message}`
    : message || "알 수 없는 오류";
}

function getClientSummary() {
  const userAgent = navigator.userAgent || "";
  const safariVersion = userAgent.match(/Version\/([\d.]+)/)?.[1];
  const iosVersion = userAgent.match(/OS ([\d_]+) like Mac OS X/)?.[1];
  const isIPad =
    /iPad/.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const device = isIPad ? "iPad" : navigator.platform || "기기 미상";
  const os = iosVersion ? `iPadOS ${iosVersion.replace(/_/g, ".")}` : null;
  const browser = safariVersion ? `Safari ${safariVersion}` : "브라우저 버전 미상";
  return [device, os, browser].filter(Boolean).join(" · ");
}

function logImportDiagnostics() {
  addConnectionLog(`앱 ${APP_BUILD} · PDF.js 3.11.174`);
  addConnectionLog(getClientSummary());
  addConnectionLog(
    [
      `Worker ${typeof Worker === "function" ? "가능" : "없음"}`,
      `FileReader ${typeof FileReader === "function" ? "가능" : "없음"}`,
      `Blob.arrayBuffer ${
        typeof Blob !== "undefined" &&
        typeof Blob.prototype.arrayBuffer === "function"
          ? "가능"
          : "대체 경로"
      }`,
    ].join(" · "),
  );
}

function fallbackBookId(file) {
  const value = `${file.name}:${file.size}:${file.lastModified}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${(hash >>> 0).toString(16)}`;
}

async function inspectPdf(arrayBuffer, { sourceHash, fileName }) {
  addConnectionLog("1/4 PDF 엔진 불러오는 중…");
  const pdfjs = await getPdfLibrary();
  addConnectionLog(
    `1/4 PDF 엔진 준비 완료 · ${pdfjs.version || "버전 미상"}`,
    "success",
  );
  addConnectionLog("2/4 PDF 문서 여는 중…");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(arrayBuffer),
    isEvalSupported: false,
  });
  const pdfDocument = await loadingTask.promise;
  const pageCount = pdfDocument.numPages;
  const fingerprint = pdfDocument.fingerprints?.[0] || null;
  addConnectionLog(
    `2/4 PDF 열기 완료 · ${pageCount}쪽`,
    "success",
  );

  let index = null;
  let analysisError = null;
  try {
    addConnectionLog("3/4 2단 문항 구조 분석을 시작합니다.");
    index = await analyzeGojangeePdf({
      pdfDocument,
      Util: pdfjs.Util,
      sourceHash: sourceHash || fingerprint || fileName,
      fileName,
      onProgress: ({ pageNumber, pageCount, candidateCount }) => {
        addConnectionLog(
          `문항 탐색 ${pageNumber}/${pageCount}쪽 · 후보 ${candidateCount}개`,
        );
      },
    });
    addConnectionLog(
      `문항 연결 완료: ${index.range.first}–${index.range.last}, ${index.range.count}문항`,
      "success",
    );
  } catch (error) {
    analysisError = error;
    addConnectionLog(`3/4 문항 연결 실패 · ${describeError(error)}`, "error");
  } finally {
    try {
      await pdfDocument.destroy();
    } catch (error) {
      addConnectionLog(
        `PDF 임시 작업 정리 경고 · ${describeError(error)}`,
        "error",
      );
    }
  }

  return {
    pageCount,
    fingerprint,
    index,
    analysisError,
  };
}

async function importBook(file) {
  if (
    !file ||
    (!file.name.toLowerCase().endsWith(".pdf") &&
      file.type !== "application/pdf")
  ) {
    setBookMessage("PDF 파일만 추가할 수 있습니다.", true);
    return;
  }

  elements.addBookButton.disabled = true;
  elements.bookSelect.disabled = true;
  openUtilityPanel(elements.connectionPanel);
  setBookMessage("PDF를 확인하고 이 기기에 저장하는 중입니다.");
  setConnectionStatus("연결 중", "working");
  addConnectionLog(
    `선택: ${file.name} · ${formatFileSize(file.size)}`,
  );
  logImportDiagnostics();

  let importStage = "파일 읽기";
  try {
    addConnectionLog("파일 읽는 중…");
    const hashBuffer = await readBlobAsArrayBuffer(file);
    addConnectionLog("파일 읽기 완료", "success");
    importStage = "파일 식별값 계산";
    const sha256 = await sha256Hex(hashBuffer);
    addConnectionLog(
      sha256
        ? `파일 식별값 계산 완료: ${sha256.slice(0, 12)}…`
        : "파일 식별값 대신 브라우저 기본값을 사용합니다.",
      "success",
    );
    importStage = "PDF 열기 또는 문항 분석";
    const { pageCount, fingerprint, index, analysisError } =
      await inspectPdf(hashBuffer.slice(0), {
        sourceHash: sha256,
        fileName: file.name,
      });
    const id = sha256 ? `local-${sha256}` : fallbackBookId(file);
    const title = file.name.replace(/\.pdf$/i, "").trim() || "내 답지";
    const usesBuiltInRecovery =
      !index && sha256 === problemIndex.source.sha256;
    if (usesBuiltInRecovery) {
      addConnectionLog(
        "분석은 실패했지만 기본 답지와 같은 파일이라 내장 연결 정보로 복구합니다.",
        "success",
      );
    }
    const record = {
      id,
      title,
      fileName: file.name,
      pageCount,
      size: file.size,
      type: file.type || "application/pdf",
      lastModified: file.lastModified,
      addedAt: Date.now(),
      sha256,
      fingerprint,
      blob: file,
      problemIndex: index,
      analysisVersion: PDF_ANALYZER_VERSION,
      analysisStatus: index
        ? "connected"
        : usesBuiltInRecovery
          ? "recovered"
          : "failed",
      analysisMessage: analysisError ? describeError(analysisError) : null,
      analysisAttemptedAt: Date.now(),
    };

    importStage = "기기 저장소에 저장";
    addConnectionLog("4/4 이 기기에 저장하는 중…");
    await saveStoredBook(record);
    addConnectionLog("4/4 PDF와 연결 정보를 저장했습니다.", "success");
    const book = normalizeStoredBook(record);
    books.set(book.id, book);
    autoAnalysisAttempted.add(book.id);
    renderBookOptions();
    activateBook(book);
    const hasUsableIndex = Boolean(book.index);
    setConnectionStatus(
      hasUsableIndex ? "연결 완료" : "확인 필요",
      hasUsableIndex ? "idle" : "error",
    );

    if (hasUsableIndex) {
      elements.connectionPanel.open = false;
    }

    if (analysisError) {
      if (usesBuiltInRecovery) {
        setBookMessage(
          `${pageCount}쪽 · 기본 답지의 내장 연결 정보로 복구됨`,
        );
      } else {
        setBookMessage(
          "PDF는 저장했지만 문항 구조를 연결하지 못했습니다. 로그를 확인해 주세요.",
          true,
        );
      }
    }

    if (navigator.storage?.persist) {
      void navigator.storage.persist();
    }
  } catch (error) {
    console.error("답지 PDF 저장 실패:", error);
    addConnectionLog(
      `PDF 처리 실패 [${importStage}] · ${describeError(error)}`,
      "error",
    );
    setConnectionStatus("실패", "error");
    setBookMessage(
      "PDF를 저장할 수 없습니다. 파일 또는 브라우저 저장 공간을 확인해 주세요.",
      true,
    );
  } finally {
    elements.addBookButton.disabled = false;
    elements.bookSelect.disabled = false;
    elements.bookFileInput.value = "";
  }
}

function connectStoredBook(book, { force = false } = {}) {
  if (!book || book.builtIn || (!force && book.index)) {
    return Promise.resolve(book?.index || null);
  }
  if (analysisInFlight.has(book.id)) {
    return analysisInFlight.get(book.id);
  }

  const connection = (async () => {
    autoAnalysisAttempted.add(book.id);
    elements.analyzeBookButton.disabled = true;
    openUtilityPanel(elements.connectionPanel);
    setConnectionStatus("연결 중", "working");
    addConnectionLog(
      `${force ? "재분석" : "자동 연결"}: ${book.fileName}`,
    );

    try {
      const arrayBuffer = await readBlobAsArrayBuffer(book.blob);
      const sha256 = book.sha256 || (await sha256Hex(arrayBuffer));
      if (sha256 && !book.sha256) {
        book.sha256 = sha256;
        addConnectionLog(
          `파일 식별값 계산 완료: ${sha256.slice(0, 12)}…`,
          "success",
        );
      }

      const { pageCount, fingerprint, index, analysisError } =
        await inspectPdf(arrayBuffer.slice(0), {
          sourceHash: sha256,
          fileName: book.fileName,
        });
      book.pageCount = pageCount;
      book.fingerprint = fingerprint;

      if (index) {
        book.index = index;
        book.indexSource = "analyzed";
        book.problemIndex = index;
        book.analysisVersion = PDF_ANALYZER_VERSION;
        book.analysisStatus = "connected";
        book.analysisMessage = null;
        book.analysisAttemptedAt = Date.now();
        await saveStoredBook(toStoredBookRecord(book));
        addConnectionLog(
          "새 문항 연결 정보를 브라우저에 저장했습니다.",
          "success",
        );
        setConnectionStatus("연결 완료");
        if (activeBook.id === book.id) {
          activateBook(book);
        }
        elements.connectionPanel.open = false;
        return index;
      }

      book.analysisVersion = PDF_ANALYZER_VERSION;
      book.analysisStatus = "failed";
      book.analysisMessage =
        analysisError
          ? describeError(analysisError)
          : "문항 구조를 연결하지 못했습니다.";
      book.analysisAttemptedAt = Date.now();
      await saveStoredBook(toStoredBookRecord(book));
      setConnectionStatus("확인 필요", "error");
      if (activeBook.id === book.id) {
        setBookMessage(
          "PDF는 저장되어 있지만 문항 구조를 연결하지 못했습니다.",
          true,
        );
      }
      return analysisError ? null : book.index;
    } catch (error) {
      console.error("저장된 PDF 연결 실패:", error);
      book.analysisVersion = PDF_ANALYZER_VERSION;
      book.analysisStatus = "failed";
      book.analysisMessage = describeError(error);
      book.analysisAttemptedAt = Date.now();
      await saveStoredBook(toStoredBookRecord(book)).catch(() => {});
      addConnectionLog(`PDF 연결 실패: ${describeError(error)}`, "error");
      setConnectionStatus("실패", "error");
      if (activeBook.id === book.id) {
        setBookMessage("저장된 PDF를 분석할 수 없습니다.", true);
      }
      return null;
    } finally {
      analysisInFlight.delete(book.id);
      elements.analyzeBookButton.disabled = false;
    }
  })();

  analysisInFlight.set(book.id, connection);
  return connection;
}

function openActiveBook() {
  if (!activeBook) {
    return;
  }

  const pdfUrl = activeBook.builtIn
    ? new URL(problemIndex.source.url, window.location.href).href
    : URL.createObjectURL(activeBook.blob);
  const anchor = document.createElement("a");
  anchor.href = pdfUrl;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  anchor.click();

  if (!activeBook.builtIn) {
    window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 300_000);
  }
}

async function removeActiveBook() {
  if (!activeBook || activeBook.builtIn) {
    return;
  }

  const bookToRemove = activeBook;
  const confirmed = window.confirm(
    `"${bookToRemove.title}" 답지를 이 기기에서 삭제할까요?`,
  );
  if (!confirmed) {
    return;
  }

  try {
    await deleteStoredBook(bookToRemove.id);
    books.delete(bookToRemove.id);
    activateBook(defaultBook);
    renderBookOptions();
    setBookMessage("저장된 답지를 삭제하고 기본 답지로 전환했습니다.");
  } catch (error) {
    console.error("답지 삭제 실패:", error);
    setBookMessage("저장된 답지를 삭제할 수 없습니다.", true);
  }
}

async function initializeBookLibrary() {
  setFormEnabled(false);
  elements.bookSelect.disabled = true;

  try {
    const storedBooks = await listStoredBooks();
    storedBooks.forEach((record) => {
      const book = normalizeStoredBook(record);
      books.set(book.id, book);
    });
  } catch (error) {
    console.error("답지 목록 로드 실패:", error);
    setBookMessage(
      "저장된 답지 목록을 불러오지 못했습니다. 기본 답지는 사용할 수 있습니다.",
      true,
    );
  }

  renderBookOptions();
  let savedBookId = DEFAULT_BOOK_ID;
  try {
    savedBookId =
      localStorage.getItem(ACTIVE_BOOK_STORAGE_KEY) || DEFAULT_BOOK_ID;
  } catch {
    // Fall back to the built-in book.
  }

  activateBook(books.get(savedBookId) || defaultBook, { persist: false });
  if (!isCoarsePointer() && !elements.form.hidden) {
    elements.input.focus({ preventScroll: true });
  }
}

function setFormEnabled(enabled) {
  formEnabled = enabled;
  elements.input.disabled = !enabled;
  elements.submitButton.disabled = !enabled;
  elements.keypadToggle.disabled = !enabled;
  elements.keypadKeys.forEach((key) => {
    key.disabled = !enabled;
  });
  updateStepButtons();
}

function setKeypadOpen(open) {
  elements.keypad.hidden = !open;
  elements.keypadToggle.setAttribute("aria-expanded", String(open));
  elements.keypadToggle.textContent = open ? "키패드 닫기" : "키패드";
}

function updateStepButtons() {
  const value = Number(elements.input.value);
  const hasNumber = /^\d+$/.test(elements.input.value);
  const currentProblem = hasNumber ? value : activeProblem;

  elements.decrementButton.disabled =
    !formEnabled ||
    currentProblem === null ||
    currentProblem <= firstProblem;
  elements.incrementButton.disabled =
    !formEnabled ||
    (currentProblem !== null && currentProblem >= lastProblem);
}

function setMessage(message = "") {
  elements.formMessage.textContent = message;
  elements.input.setAttribute("aria-invalid", message ? "true" : "false");
}

function syncInputState() {
  elements.input.value = elements.input.value
    .replace(/[^\d]/g, "")
    .slice(0, 3);
  updateStepButtons();
  if (elements.formMessage.textContent) {
    setMessage();
  }
}

function appendDigit(digit) {
  const currentValue = elements.input.value;
  if (currentValue.length >= 3) {
    return;
  }

  elements.input.value =
    currentValue === "0" ? digit : `${currentValue}${digit}`;
  syncInputState();
}

function backspaceDigit() {
  elements.input.value = elements.input.value.slice(0, -1);
  syncInputState();
}

function setMediaLoading(kind) {
  const media = mediaElements[kind];
  media.container.classList.add("is-loading");
  media.container.removeAttribute("data-image-source");
  media.image.hidden = false;
  media.error.hidden = true;
}

function setMediaLoaded(kind, sourceType) {
  const media = mediaElements[kind];
  media.container.classList.remove("is-loading");
  media.container.dataset.imageSource = sourceType;
}

function setMediaError(kind) {
  const media = mediaElements[kind];
  media.container.classList.remove("is-loading");
  media.container.removeAttribute("data-image-source");
  media.image.hidden = true;
  media.error.hidden = false;
}

function releaseObjectUrl(kind) {
  if (objectUrls[kind]) {
    URL.revokeObjectURL(objectUrls[kind]);
    objectUrls[kind] = null;
  }
}

function clearMediaImage(kind) {
  imageRequestTokens[kind] += 1;
  const { image } = mediaElements[kind];
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  releaseObjectUrl(kind);
}

function resetSolution() {
  clearMediaImage("solution");
  elements.solutionToggle.setAttribute("aria-expanded", "false");
  elements.solutionToggleText.textContent = "해설 보기";
  elements.solutionPanel.hidden = true;
  elements.solutionImage.hidden = false;
  elements.solutionImage.alt = "";
  elements.solutionError.hidden = true;
  elements.solutionMedia.classList.add("is-loading");
  elements.solutionMedia.removeAttribute("data-image-source");
  solutionLoadedFor = null;
}

function cacheKey(book, problemNumber, kind) {
  const index = getBookIndex(book);
  const namespace = [
    index.source.sha256,
    `renderer-${RENDERER_VERSION}`,
    `scale-${index.render.scale}`,
  ].join(":");
  return `${namespace}:${problemNumber}:${kind}`;
}

function rememberImage(key, blob) {
  memoryImageCache.delete(key);
  memoryImageCache.set(key, blob);

  while (memoryImageCache.size > MAX_MEMORY_IMAGES) {
    const oldestKey = memoryImageCache.keys().next().value;
    memoryImageCache.delete(oldestKey);
  }
}

function recallImage(key) {
  const blob = memoryImageCache.get(key);
  if (!blob) {
    return null;
  }

  rememberImage(key, blob);
  return blob;
}

function getCacheDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  if (!cacheDatabasePromise) {
    cacheDatabasePromise = new Promise((resolve) => {
      const request = indexedDB.open(CACHE_DB_NAME, 1);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) {
          database.createObjectStore(CACHE_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  return cacheDatabasePromise;
}

async function readCachedImage(key) {
  const database = await getCacheDatabase();
  if (!database) {
    return null;
  }

  return new Promise((resolve) => {
    const transaction = database.transaction(CACHE_STORE_NAME, "readonly");
    const request = transaction.objectStore(CACHE_STORE_NAME).get(key);
    request.onsuccess = () => {
      resolve(request.result instanceof Blob ? request.result : null);
    };
    request.onerror = () => resolve(null);
    transaction.onabort = () => resolve(null);
  });
}

async function writeCachedImage(key, blob) {
  const database = await getCacheDatabase();
  if (!database) {
    return;
  }

  await new Promise((resolve) => {
    const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
    transaction.objectStore(CACHE_STORE_NAME).put(blob, key);
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
}

function getPdfLibrary() {
  if (!pdfLibraryPromise) {
    pdfLibraryPromise = Promise.all([
      import("pdfjs-dist/legacy/build/pdf.js"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.js?url"),
    ]).then(([pdfjs, workerModule]) => {
      const library =
        pdfjs.default?.getDocument && !pdfjs.getDocument
          ? pdfjs.default
          : pdfjs;
      library.GlobalWorkerOptions.workerSrc = workerModule.default;
      return library;
    });
  }
  return pdfLibraryPromise;
}

function getPdfDocument(book) {
  if (
    pdfDocumentState.bookId !== book.id ||
    !pdfDocumentState.promise
  ) {
    const documentPromise = getPdfLibrary()
      .then(async ({ getDocument }) => {
        if (book.builtIn) {
          return getDocument({
            url: book.index.source.url,
            isEvalSupported: false,
          }).promise;
        }

        const data = new Uint8Array(await readBlobAsArrayBuffer(book.blob));
        return getDocument({ data, isEvalSupported: false }).promise;
      })
      .catch((error) => {
        if (pdfDocumentState.bookId === book.id) {
          pdfDocumentState = { bookId: null, promise: null };
        }
        throw error;
      });
    pdfDocumentState = { bookId: book.id, promise: documentPromise };
  }
  return pdfDocumentState.promise;
}

function getCanvasContext(canvas) {
  return (
    canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    }) || canvas.getContext("2d")
  );
}

async function renderPdfPage(book, pageNumber) {
  const renderSettings = book.index.render;
  const pdfDocument = await getPdfDocument(book);
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale: renderSettings.scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const context = getCanvasContext(canvas);
  if (!context) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: context,
    viewport,
    background: "rgb(255, 255, 255)",
  }).promise;

  return canvas;
}

function getRenderedPage(book, pageNumber) {
  const pageKey = `${book.id}:${pageNumber}`;
  if (renderedPageCache.has(pageKey)) {
    const cached = renderedPageCache.get(pageKey);
    renderedPageCache.delete(pageKey);
    renderedPageCache.set(pageKey, cached);
    return cached;
  }

  const renderPromise = renderPdfPage(book, pageNumber).catch((error) => {
    renderedPageCache.delete(pageKey);
    throw error;
  });
  renderedPageCache.set(pageKey, renderPromise);

  while (renderedPageCache.size > MAX_RENDERED_PAGES) {
    const oldestPage = renderedPageCache.keys().next().value;
    renderedPageCache.delete(oldestPage);
  }

  return renderPromise;
}

function removeFooterBrand(
  canvas,
  pageLeftPx,
  pageTopPx,
  renderSettings,
) {
  const scale = renderSettings.scale;
  const [brandLeft, brandTop, brandRight, brandBottom] =
    renderSettings.footer_brand_rect;
  const left = Math.max(0, Math.floor(brandLeft * scale) - pageLeftPx);
  const top = Math.max(0, Math.floor(brandTop * scale) - pageTopPx);
  const right = Math.min(
    canvas.width,
    Math.ceil(brandRight * scale) - pageLeftPx,
  );
  const bottom = Math.min(
    canvas.height,
    Math.ceil(brandBottom * scale) - pageTopPx,
  );

  if (left >= right || top >= bottom) {
    return;
  }

  const context = getCanvasContext(canvas);
  const imageData = context.getImageData(left, top, right - left, bottom - top);
  const pixels = imageData.data;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const isTeal =
      red > 90 && green - red >= 20 && blue - red >= 25;
    const isLightGray =
      red >= 115 &&
      red <= 254 &&
      Math.abs(red - green) <= 25 &&
      Math.abs(red - blue) <= 25;

    if (isTeal || isLightGray) {
      pixels[index] = 255;
      pixels[index + 1] = 255;
      pixels[index + 2] = 255;
      pixels[index + 3] = 255;
    }
  }

  context.putImageData(imageData, left, top);
}

function cropPageCanvas(pageCanvas, rect, renderSettings) {
  const scale = renderSettings.scale;
  const [x0, y0, x1, y1] = rect;
  const left = Math.max(0, Math.floor(x0 * scale));
  const top = Math.max(0, Math.floor(y0 * scale));
  const right = Math.min(pageCanvas.width, Math.ceil(x1 * scale));
  const bottom = Math.min(pageCanvas.height, Math.ceil(y1 * scale));

  if (right <= left || bottom <= top) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = right - left;
  canvas.height = bottom - top;
  const context = getCanvasContext(canvas);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    pageCanvas,
    left,
    top,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  removeFooterBrand(canvas, left, top, renderSettings);
  return canvas;
}

function trimCanvasVertical(canvas, renderSettings) {
  const context = getCanvasContext(canvas);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const threshold = renderSettings.nonwhite_threshold;
  let firstContentRow = -1;
  let lastContentRow = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    const rowStart = y * canvas.width * 4;
    let rowHasContent = false;

    for (let x = 0; x < canvas.width; x += 1) {
      const pixel = rowStart + x * 4;
      if (
        pixels[pixel] < threshold ||
        pixels[pixel + 1] < threshold ||
        pixels[pixel + 2] < threshold
      ) {
        rowHasContent = true;
        break;
      }
    }

    if (rowHasContent) {
      if (firstContentRow === -1) {
        firstContentRow = y;
      }
      lastContentRow = y;
    }
  }

  if (firstContentRow === -1) {
    return null;
  }

  const margin = renderSettings.vertical_trim_margin_px;
  const top = Math.max(0, firstContentRow - margin);
  const bottom = Math.min(canvas.height, lastContentRow + margin + 1);
  const trimmed = document.createElement("canvas");
  trimmed.width = canvas.width;
  trimmed.height = bottom - top;
  const trimmedContext = getCanvasContext(trimmed);
  trimmedContext.fillStyle = "#ffffff";
  trimmedContext.fillRect(0, 0, trimmed.width, trimmed.height);
  trimmedContext.drawImage(
    canvas,
    0,
    top,
    canvas.width,
    trimmed.height,
    0,
    0,
    canvas.width,
    trimmed.height,
  );
  return trimmed;
}

function joinCanvases(canvases, renderSettings) {
  if (canvases.length === 1) {
    return canvases[0];
  }

  const gap = renderSettings.segment_join_gap_px;
  const width = Math.max(...canvases.map((canvas) => canvas.width));
  const height =
    canvases.reduce((total, canvas) => total + canvas.height, 0) +
    gap * (canvases.length - 1);
  const joined = document.createElement("canvas");
  joined.width = width;
  joined.height = height;
  const context = getCanvasContext(joined);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  let y = 0;
  canvases.forEach((canvas) => {
    context.drawImage(canvas, 0, y);
    y += canvas.height + gap;
  });
  return joined;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Rendered image could not be encoded."));
      }
    }, "image/png");
  });
}

async function renderProblemImage(book, problemNumber, kind) {
  const index = getBookIndex(book);
  const renderSettings = index.render;
  const specs = index.problems[String(problemNumber)]?.[kind];
  if (!specs?.length) {
    throw new Error(`Missing ${kind} crop metadata.`);
  }

  const canvases = [];
  for (const spec of specs) {
    const pageCanvas = await getRenderedPage(book, spec.page);
    const cropped = cropPageCanvas(
      pageCanvas,
      spec.rect,
      renderSettings,
    );
    if (!cropped) {
      continue;
    }

    const trimmed = trimCanvasVertical(cropped, renderSettings);
    if (trimmed) {
      canvases.push(trimmed);
    }
  }

  if (!canvases.length) {
    throw new Error(`The rendered ${kind} area is empty.`);
  }

  return canvasToBlob(joinCanvases(canvases, renderSettings));
}

async function getProblemImage(book, problemNumber, kind) {
  const key = cacheKey(book, problemNumber, kind);
  const memoryBlob = recallImage(key);
  if (memoryBlob) {
    return { blob: memoryBlob, sourceType: "memory" };
  }

  if (imageRequests.has(key)) {
    return imageRequests.get(key);
  }

  const request = (async () => {
    const storedBlob = await readCachedImage(key);
    if (storedBlob) {
      rememberImage(key, storedBlob);
      return { blob: storedBlob, sourceType: "indexeddb" };
    }

    const renderedBlob = await renderProblemImage(
      book,
      problemNumber,
      kind,
    );
    rememberImage(key, renderedBlob);
    void writeCachedImage(key, renderedBlob);
    return { blob: renderedBlob, sourceType: "pdf" };
  })().finally(() => {
    imageRequests.delete(key);
  });

  imageRequests.set(key, request);
  return request;
}

async function displayProblemImage(book, problemNumber, kind) {
  const media = mediaElements[kind];
  const token = ++imageRequestTokens[kind];
  const bookRevision = activeBookRevision;
  setMediaLoading(kind);

  try {
    const { blob, sourceType } = await getProblemImage(
      book,
      problemNumber,
      kind,
    );
    if (
      token !== imageRequestTokens[kind] ||
      bookRevision !== activeBookRevision ||
      book.id !== activeBook.id ||
      problemNumber !== activeProblem
    ) {
      return false;
    }

    const imageUrl = URL.createObjectURL(blob);
    releaseObjectUrl(kind);
    objectUrls[kind] = imageUrl;
    media.image.onload = () => {
      if (token === imageRequestTokens[kind]) {
        setMediaLoaded(kind, sourceType);
      }
      media.image.onload = null;
      media.image.onerror = null;
    };
    media.image.onerror = () => {
      if (token === imageRequestTokens[kind]) {
        setMediaError(kind);
      }
      media.image.onload = null;
      media.image.onerror = null;
    };
    media.image.src = imageUrl;
    return true;
  } catch (error) {
    console.error(`${kind} 이미지 생성 실패:`, error);
    if (
      token === imageRequestTokens[kind] &&
      bookRevision === activeBookRevision &&
      book.id === activeBook.id &&
      problemNumber === activeProblem
    ) {
      setMediaError(kind);
    }
    return false;
  }
}

function showProblem(problemNumber) {
  const paddedNumber = String(problemNumber).padStart(3, "0");
  const book = activeBook;
  activeProblem = problemNumber;
  resetSolution();
  clearMediaImage("answer");

  elements.resultNumber.textContent = paddedNumber;
  elements.answerImage.alt = `${problemNumber}번 문항 정답`;
  elements.resultSection.hidden = false;
  updateStepButtons();
  void displayProblemImage(book, problemNumber, "answer");

  if (window.matchMedia("(max-width: 640px)").matches) {
    window.requestAnimationFrame(() => {
      elements.resultSection.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }
}

function selectProblem(problemNumber) {
  const problems = getBookIndex()?.problems;
  if (!problems?.[String(problemNumber)]) {
    setMessage("존재하지 않는 문항 번호입니다.");
    return;
  }

  setMessage();
  elements.input.value = String(problemNumber);
  showProblem(problemNumber);
}

function stepProblem(delta) {
  if (!getBookIndex()) {
    return;
  }

  const rawValue = elements.input.value.trim();
  const parsedValue = Number(rawValue);
  let baseValue;

  if (/^\d+$/.test(rawValue) && Number.isSafeInteger(parsedValue)) {
    baseValue = parsedValue;
  } else if (activeProblem !== null) {
    baseValue = activeProblem;
  } else {
    selectProblem(firstProblem);
    return;
  }

  const nextProblem = Math.min(
    lastProblem,
    Math.max(firstProblem, baseValue + delta),
  );
  selectProblem(nextProblem);
}

function validateInput(value) {
  const problems = getBookIndex()?.problems;
  const normalized = value.trim();
  if (!normalized) {
    return { error: "문항 번호를 입력해 주세요." };
  }

  if (!/^\d+$/.test(normalized)) {
    return { error: "문항 번호는 숫자로 입력해 주세요." };
  }

  const problemNumber = Number(normalized);
  if (
    !Number.isSafeInteger(problemNumber) ||
    !problems?.[String(problemNumber)]
  ) {
    return { error: "존재하지 않는 문항 번호입니다." };
  }

  return { problemNumber };
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  setKeypadOpen(false);
  elements.input.blur();

  if (!getBookIndex()) {
    return;
  }

  const result = validateInput(elements.input.value);
  if (result.error) {
    setMessage(result.error);
    if (!isCoarsePointer()) {
      elements.input.focus();
    }
    return;
  }

  if (navigator.storage?.persist) {
    void navigator.storage.persist();
  }
  selectProblem(result.problemNumber);
});

elements.input.addEventListener("input", syncInputState);

elements.input.addEventListener("focus", () => {
  if (isCoarsePointer()) {
    setKeypadOpen(true);
  }
});

elements.input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    stepProblem(event.key === "ArrowUp" ? 1 : -1);
  }
});

elements.decrementButton.addEventListener("click", () => stepProblem(-1));
elements.incrementButton.addEventListener("click", () => stepProblem(1));
elements.keypadToggle.addEventListener("click", () => {
  const willOpen =
    elements.keypadToggle.getAttribute("aria-expanded") !== "true";
  setKeypadOpen(willOpen);
});

elements.keypad.addEventListener("click", (event) => {
  const key = event.target.closest(".keypad-key");
  if (!key || key.disabled) {
    return;
  }

  if (key.dataset.digit !== undefined) {
    appendDigit(key.dataset.digit);
    return;
  }

  if (key.dataset.action === "clear") {
    elements.input.value = "";
    syncInputState();
  } else if (key.dataset.action === "backspace") {
    backspaceDigit();
  }
});

elements.solutionToggle.addEventListener("click", () => {
  if (!activeProblem) {
    return;
  }

  const willOpen =
    elements.solutionToggle.getAttribute("aria-expanded") !== "true";
  elements.solutionToggle.setAttribute("aria-expanded", String(willOpen));
  elements.solutionToggleText.textContent = willOpen
    ? "해설 숨기기"
    : "해설 보기";
  elements.solutionPanel.hidden = !willOpen;

  if (willOpen && solutionLoadedFor !== activeProblem) {
    const requestedBook = activeBook;
    const requestedProblem = activeProblem;
    solutionLoadedFor = requestedProblem;
    elements.solutionImage.alt = `${requestedProblem}번 문항 해설`;
    void displayProblemImage(
      requestedBook,
      requestedProblem,
      "solution",
    ).then((loaded) => {
      if (
        !loaded &&
        activeBook.id === requestedBook.id &&
        activeProblem === requestedProblem
      ) {
        solutionLoadedFor = null;
      }
    });
  }
});

elements.bookSelect.addEventListener("change", () => {
  const book = books.get(elements.bookSelect.value);
  if (book) {
    activateBook(book);
    elements.bookPanel.open = false;
  }
});

elements.bookPanel.addEventListener("toggle", () => {
  if (elements.bookPanel.open) {
    elements.connectionPanel.open = false;
  }
});

elements.connectionPanel.addEventListener("toggle", () => {
  if (elements.connectionPanel.open) {
    elements.bookPanel.open = false;
  }
});

elements.addBookButton.addEventListener("click", () => {
  elements.bookFileInput.click();
});

elements.bookFileInput.addEventListener("change", () => {
  const files = elements.bookFileInput.files;
  const file =
    files && files.length
      ? typeof files.item === "function"
        ? files.item(0)
        : files[0]
      : null;
  if (file) {
    void importBook(file);
  }
});

elements.openBookButton.addEventListener("click", openActiveBook);
elements.analyzeBookButton.addEventListener("click", () => {
  void connectStoredBook(activeBook, { force: true });
});
elements.removeBookButton.addEventListener("click", () => {
  void removeActiveBook();
});

window.addEventListener("beforeunload", () => {
  releaseObjectUrl("answer");
  releaseObjectUrl("solution");
});

void initializeBookLibrary();
