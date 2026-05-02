export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string,
  pollIntervalMs = 50,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (await predicate()) {
      return;
    }

    await Bun.sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`);
}

export async function waitForResult<T>(
  resultPromise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
