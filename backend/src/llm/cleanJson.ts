/**
 * Strip code fences (```json ... ```) and extract clean JSON strings.
 */
export function cleanJsonText(raw: string): string {
  let s = raw.trim();

  // If the whole string is wrapped in code fences
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*\n?/i, "");
    s = s.replace(/\n?```\s*$/i, "");
    s = s.trim();
  }

  // If there are code fences somewhere inside the response
  const blockMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (blockMatch && blockMatch[1]) {
    s = blockMatch[1].trim();
  }

  return s;
}

/**
 * Attempt to extract a valid JSON string even if surrounded by commentary.
 */
export function tryExtractJson(raw: string): string {
  const cleaned = cleanJsonText(raw);
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Attempt outer object extraction
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {}
    }

    // Attempt outer array extraction
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      const candidate = cleaned.slice(firstBracket, lastBracket + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {}
    }
  }

  return cleaned;
}
