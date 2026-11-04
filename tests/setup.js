// Testlerde tarayıcıya özgü nesnelerin yerine geçenler. Bu dosya her test dosyasında
// ilk içe aktarılır; böylece site modülleri yüklenirken localStorage ve document hazırdır.

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
  clear: () => memory.clear(),
  key: (index) => [...memory.keys()][index] ?? null,
  get length() { return memory.size; },
};
globalThis.document = { baseURI: 'http://localhost/' };

/** Site modülleri yüklenmeden önce tarayıcı deposuna kayıt koyar. */
export function seedStorage(key, value) {
  memory.set(key, JSON.stringify(value));
}

export const near = (assert, actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≠ ${expected}`);
