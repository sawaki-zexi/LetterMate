const hanCharacterPattern = /\p{Script=Han}/gu;
const latinLetterPattern = /[A-Za-z]/gu;

export function isChineseContent(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;

  const hanCount = normalized.match(hanCharacterPattern)?.length ?? 0;
  if (hanCount < 2) return false;

  const latinCount = normalized.match(latinLetterPattern)?.length ?? 0;
  return hanCount >= Math.max(2, Math.ceil(latinCount * 0.1));
}
