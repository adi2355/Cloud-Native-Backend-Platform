const SIZE_REGEX = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i;

export function parseByteSize(size: string): number {
  const trimmed = size.trim().toLowerCase();
  const match = SIZE_REGEX.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid byte size format: "${size}"`);
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid byte size value: "${size}"`);
  }

  const unit = match[2] ?? 'b';
  const multiplier = unit === 'gb'
    ? 1024 ** 3
    : unit === 'mb'
    ? 1024 ** 2
    : unit === 'kb'
    ? 1024
    : 1;

  return Math.floor(value * multiplier);
}
