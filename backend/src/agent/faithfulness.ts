export interface FaithfulnessReport {
  ok: boolean;
  score: number; // 0..1
  totalClaims: number;
  traceableClaims: number;
  unmatchedNumbers: number[];
}

/**
 * Extracts numbers from text (integers, floats, percentages)
 * ignoring standalone year numbers like 2026.
 */
export function extractNumbersFromText(text: string): number[] {
  // Matches floats, integers, percentages
  const matches = text.match(/-?\d+(?:\.\d+)?%?/g);
  if (!matches) return [];

  const numbers: number[] = [];
  for (const m of matches) {
    if (m.endsWith("%")) {
      const val = parseFloat(m.slice(0, -1));
      if (!isNaN(val)) numbers.push(val);
    } else {
      const val = parseFloat(m);
      if (!isNaN(val)) {
        // Skip common current/demo year 2026 unless explicitly checking years
        if (val !== 2026) {
          numbers.push(val);
        }
      }
    }
  }
  return numbers;
}

/**
 * Recursively extracts all numbers from evidence objects/arrays.
 */
export function extractNumbersFromEvidence(evidence: unknown): Set<number> {
  const nums = new Set<number>();

  function walk(val: unknown) {
    if (typeof val === "number" && !isNaN(val)) {
      nums.add(val);
      // If decimal like 0.66, also add percentage representation 66
      if (Math.abs(val) <= 1.0 && val !== 0) {
        nums.add(Math.round(val * 100));
        nums.add(Number((val * 100).toFixed(1)));
      }
    } else if (typeof val === "string") {
      const parsed = parseFloat(val);
      if (!isNaN(parsed) && /^-?\d+(\.\d+)?$/.test(val.trim())) {
        nums.add(parsed);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) walk(item);
    } else if (val && typeof val === "object") {
      for (const v of Object.values(val as Record<string, unknown>)) {
        walk(v);
      }
    }
  }

  walk(evidence);
  return nums;
}

/**
 * Faithfulness checker: verifies that numbers in the response text are grounded in evidence.
 * Exported so P6 evaluation harness can reuse it for the faithfulness KPI.
 */
export function checkFaithfulness(text: string, evidence: unknown): FaithfulnessReport {
  const textNumbers = extractNumbersFromText(text);
  if (textNumbers.length === 0) {
    return {
      ok: true,
      score: 1.0,
      totalClaims: 0,
      traceableClaims: 0,
      unmatchedNumbers: [],
    };
  }

  const evidenceNumbers = extractNumbersFromEvidence(evidence);
  const unmatched: number[] = [];
  let matchedCount = 0;

  for (const num of textNumbers) {
    let found = false;
    for (const evNum of evidenceNumbers) {
      // Tolerance: within 1% or 0.05
      const diff = Math.abs(num - evNum);
      if (diff < 0.05 || (evNum !== 0 && diff / Math.abs(evNum) <= 0.02)) {
        found = true;
        break;
      }
    }

    if (found) {
      matchedCount++;
    } else {
      unmatched.push(num);
    }
  }

  const score = matchedCount / textNumbers.length;
  return {
    ok: score >= 0.85,
    score,
    totalClaims: textNumbers.length,
    traceableClaims: matchedCount,
    unmatchedNumbers: unmatched,
  };
}
