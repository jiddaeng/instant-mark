const DATABASE_NAME = "instant-mark-library";
const DATABASE_VERSION = 1;
const BOOK_STORE = "books";

let databasePromise = null;

function getDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(BOOK_STORE)) {
          database.createObjectStore(BOOK_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        reject(new Error("답지 저장소가 다른 탭에서 사용 중입니다."));
      };
    });
  }

  return databasePromise;
}

export async function listStoredBooks() {
  const database = await getDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(BOOK_STORE, "readonly");
    const request = transaction.objectStore(BOOK_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function saveStoredBook(book) {
  const database = await getDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(BOOK_STORE, "readwrite");
    transaction.objectStore(BOOK_STORE).put(book);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function deleteStoredBook(bookId) {
  const database = await getDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(BOOK_STORE, "readwrite");
    transaction.objectStore(BOOK_STORE).delete(bookId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
