export function createPerfTrace(scope, meta = {}) {
  const startedAt = Date.now();
  const prefix = `[perf:${scope}]`;
  console.log(`${prefix} start`, meta);

  return {
    mark(stage, extra = {}) {
      console.log(`${prefix} ${stage} +${Date.now() - startedAt}ms`, extra);
    },
    end(stage = 'done', extra = {}) {
      console.log(`${prefix} ${stage} +${Date.now() - startedAt}ms`, extra);
    }
  };
}
