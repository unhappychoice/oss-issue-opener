export const createConcurrencyLimiter = (capacity: number) => {
  const waiting: (() => void)[] = [];
  let active = 0;

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= capacity) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }

    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
};
