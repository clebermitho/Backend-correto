const { scoreResponse, summariseRun } = require('../../src/services/evaluation');

describe('scoreResponse', () => {
  const baseCase = {
    id: 'test-001',
    input: {},
    expected: {},
  };

  it('returns score=1 and passed=true for response meeting all criteria', () => {
    const evalCase = {
      ...baseCase,
      expected: {
        mustContain:    ['regulariza'],
        mustNotContain: ['cliente'],
        minLength:      10,
      },
    };
    const result = scoreResponse(evalCase, 'Para regularizar sua situação...', 100, 'gpt-4o-mini');

    expect(result.caseId).toBe('test-001');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.latencyMs).toBe(100);
    expect(result.details).toHaveLength(0);
  });

  it('deducts score when mustContain keyword is missing', () => {
    const evalCase = {
      ...baseCase,
      expected: { mustContain: ['regulariza', 'pagamento'] },
    };
    // 'pagamento' is missing
    const result = scoreResponse(evalCase, 'Regularize sua situação.', 50, 'gpt-4o-mini');

    expect(result.score).toBeLessThan(1);
    expect(result.details.some(d => d.includes('pagamento'))).toBe(true);
  });

  it('deducts score when mustNotContain keyword is present', () => {
    const evalCase = {
      ...baseCase,
      expected: { mustNotContain: ['cliente'] },
    };
    const result = scoreResponse(evalCase, 'O cliente deve regularizar.', 50, 'gpt-4o-mini');

    expect(result.score).toBeLessThan(1);
    expect(result.details.some(d => d.includes('cliente'))).toBe(true);
  });

  it('deducts score when response is too short', () => {
    const evalCase = {
      ...baseCase,
      expected: { minLength: 100 },
    };
    const result = scoreResponse(evalCase, 'Curto.', 30, 'gpt-4o-mini');

    expect(result.score).toBeLessThan(1);
    expect(result.details.some(d => d.includes('short'))).toBe(true);
  });

  it('score never goes below 0', () => {
    const evalCase = {
      ...baseCase,
      expected: {
        mustContain:    ['a', 'b', 'c', 'd', 'e'],
        mustNotContain: ['x', 'y'],
        minLength:      1000,
      },
    };
    const result = scoreResponse(evalCase, 'nothing here x y', 10, 'gpt-4o-mini');

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.passed).toBe(false);
  });

  it('is case-insensitive for keyword matching', () => {
    const evalCase = {
      ...baseCase,
      expected: { mustContain: ['REGULARIZA'] },
    };
    const result = scoreResponse(evalCase, 'Para regularizar sua situação.', 50, 'gpt-4o-mini');
    expect(result.score).toBe(1);
  });
});

describe('summariseRun', () => {
  it('returns correct summary for empty results', () => {
    const summary = summariseRun([]);
    expect(summary.totalCases).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.avgScore).toBe(0);
    expect(summary.avgLatencyMs).toBe(0);
  });

  it('computes averages correctly', () => {
    const results = [
      { caseId: '1', passed: true,  score: 1.0, details: [], latencyMs: 100, model: 'x' },
      { caseId: '2', passed: false, score: 0.5, details: [], latencyMs: 200, model: 'x' },
      { caseId: '3', passed: true,  score: 0.8, details: [], latencyMs: 300, model: 'x' },
    ];
    const summary = summariseRun(results);

    expect(summary.totalCases).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.avgScore).toBeCloseTo(0.767, 2);
    expect(summary.avgLatencyMs).toBe(200);
  });
});
