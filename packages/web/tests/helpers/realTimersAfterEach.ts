// Suites that enable fake timers must not leak them into the next case.
afterEach(() => {
  vi.useRealTimers();
});
