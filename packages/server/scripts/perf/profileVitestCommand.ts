/**
 * Keep the profiling corpus in one Vitest process while separating outputs:
 * the default reporter reports each completed file to the live job log (Vitest 4
 * removed `basic`, which was `default` without the summary); JSON remains the
 * authoritative end-of-run timing input.
 */
export function profileVitestArgs(
  vitestCli: string,
  files: readonly string[],
  jsonOutputPath: string,
): string[] {
  return [
    vitestCli,
    "run",
    ...files,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${jsonOutputPath}`,
  ];
}
