const DATA_URL = "data.json";

const elements = {
  form: document.querySelector("#problem-form"),
  input: document.querySelector("#problem-number"),
  decrementButton: document.querySelector("#decrement-button"),
  incrementButton: document.querySelector("#increment-button"),
  keypadToggle: document.querySelector("#keypad-toggle"),
  keypad: document.querySelector("#number-keypad"),
  keypadKeys: document.querySelectorAll(".keypad-key"),
  submitButton: document.querySelector("#submit-button"),
  formMessage: document.querySelector("#form-message"),
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

let problemData = null;
let activeProblem = null;
let solutionLoadedFor = null;
let firstProblem = 1;
let lastProblem = 1;
let formEnabled = false;

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

function setMediaLoading(container, errorElement) {
  container.classList.add("is-loading");
  errorElement.hidden = true;
}

function setMediaLoaded(container) {
  container.classList.remove("is-loading");
}

function setMediaError(container, image, errorElement) {
  container.classList.remove("is-loading");
  image.hidden = true;
  errorElement.hidden = false;
}

function resetSolution() {
  elements.solutionToggle.setAttribute("aria-expanded", "false");
  elements.solutionToggleText.textContent = "해설 보기";
  elements.solutionPanel.hidden = true;
  elements.solutionImage.removeAttribute("src");
  elements.solutionImage.hidden = false;
  elements.solutionImage.alt = "";
  elements.solutionError.hidden = true;
  elements.solutionMedia.classList.add("is-loading");
  solutionLoadedFor = null;
}

function showProblem(problemNumber, entry) {
  const paddedNumber = String(problemNumber).padStart(3, "0");
  activeProblem = problemNumber;
  resetSolution();

  elements.resultNumber.textContent = paddedNumber;
  elements.answerImage.hidden = false;
  elements.answerImage.alt = `${problemNumber}번 문항 정답`;
  setMediaLoading(elements.answerMedia, elements.answerError);
  elements.answerImage.src = entry.answer_url;

  elements.resultSection.hidden = false;
  updateStepButtons();

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
  const entry = problemData[String(problemNumber)];
  if (!entry) {
    setMessage("존재하지 않는 문항 번호입니다.");
    return;
  }

  setMessage();
  elements.input.value = String(problemNumber);
  showProblem(problemNumber, entry);
}

function stepProblem(delta) {
  if (!problemData) {
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
  const normalized = value.trim();
  if (!normalized) {
    return { error: "문항 번호를 입력해 주세요." };
  }

  if (!/^\d+$/.test(normalized)) {
    return { error: "문항 번호는 숫자로 입력해 주세요." };
  }

  const problemNumber = Number(normalized);
  if (!Number.isSafeInteger(problemNumber) || problemNumber < 1) {
    return { error: "존재하지 않는 문항 번호입니다." };
  }

  if (!problemData[String(problemNumber)]) {
    return { error: "존재하지 않는 문항 번호입니다." };
  }

  return {
    problemNumber,
    entry: problemData[String(problemNumber)],
  };
}

async function loadData() {
  setFormEnabled(false);

  try {
    const response = await fetch(DATA_URL, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    problemData = await response.json();
    const problemNumbers = Object.keys(problemData).map(Number);
    firstProblem = Math.min(...problemNumbers);
    lastProblem = Math.max(...problemNumbers);

    setFormEnabled(true);
    elements.input.focus({ preventScroll: true });
  } catch (error) {
    console.error("문항 데이터 로드 실패:", error);
    setMessage("문항 데이터를 불러올 수 없습니다.");
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!problemData) {
    return;
  }

  const result = validateInput(elements.input.value);
  if (result.error) {
    setMessage(result.error);
    elements.input.focus();
    return;
  }

  selectProblem(result.problemNumber);
  setKeypadOpen(false);
});

elements.input.addEventListener("input", () => {
  syncInputState();
});

elements.input.addEventListener("focus", () => {
  if (window.matchMedia("(pointer: coarse)").matches) {
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

elements.answerImage.addEventListener("load", () => {
  setMediaLoaded(elements.answerMedia);
});

elements.answerImage.addEventListener("error", () => {
  setMediaError(
    elements.answerMedia,
    elements.answerImage,
    elements.answerError,
  );
});

elements.solutionImage.addEventListener("load", () => {
  setMediaLoaded(elements.solutionMedia);
});

elements.solutionImage.addEventListener("error", () => {
  setMediaError(
    elements.solutionMedia,
    elements.solutionImage,
    elements.solutionError,
  );
});

elements.solutionToggle.addEventListener("click", () => {
  if (!activeProblem || !problemData) {
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
    const entry = problemData[String(activeProblem)];
    elements.solutionImage.hidden = false;
    elements.solutionImage.alt = `${activeProblem}번 문항 해설`;
    setMediaLoading(elements.solutionMedia, elements.solutionError);
    elements.solutionImage.src = entry.solution_url;
    solutionLoadedFor = activeProblem;
  }
});

loadData();
