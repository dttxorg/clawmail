const INVALID_AUTH_URL_MESSAGE = '未识别到有效的 ClawEmail auth-url，请粘贴官方 Hermes 安装命令或 t1/ 开头口令。';

export function parseClawEmailAuthToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const direct = unquote(trimmed);
  if (isClawEmailAuthToken(direct)) return direct;

  const authUrlFlagMatch = trimmed.match(/--auth-url(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"'`|;]+))/i);
  const fromFlag = authUrlFlagMatch?.[1] ?? authUrlFlagMatch?.[2] ?? authUrlFlagMatch?.[3];
  if (fromFlag && isClawEmailAuthToken(unquote(fromFlag))) {
    return unquote(fromFlag);
  }

  const embeddedTokenMatch = trimmed.match(/\bt1\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+/i);
  if (embeddedTokenMatch && isClawEmailAuthToken(trimTrailingSentencePunctuation(embeddedTokenMatch[0]))) {
    return trimTrailingSentencePunctuation(embeddedTokenMatch[0]);
  }

  return null;
}

export function parseRequiredClawEmailAuthToken(input: string): string {
  const token = parseClawEmailAuthToken(input);
  if (!token) throw new Error(INVALID_AUTH_URL_MESSAGE);
  return token;
}

export function redactClawSecrets(text: string): string {
  return text
    .replace(/(auth-url=|--auth-url\s+)(?:"[^"]+"|'[^']+'|[^\s"'`|;]+)/gi, '$1[已隐藏]')
    .replace(/(--password\s+)(?:"[^"]+"|'[^']+'|[^\s"'`|;]+)/gi, '$1[已隐藏]')
    .replace(/\bt1\/[^\s"'`|;]+/gi, 't1/[已隐藏]')
    .replace(/\bck_[A-Za-z0-9_/-]+/g, 'ck_[已隐藏]');
}

export { INVALID_AUTH_URL_MESSAGE };

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function trimTrailingSentencePunctuation(value: string): string {
  return value.replace(/[，。,.]+$/u, '');
}

function isClawEmailAuthToken(value: string): boolean {
  return /^t1\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/.test(value);
}
