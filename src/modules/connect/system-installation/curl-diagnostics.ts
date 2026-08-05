const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
]);

type SensitiveHeader = {
  name: string;
  raw: string;
  value: string;
};

function sensitiveHeader(value: string): SensitiveHeader | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const name = value.slice(0, separator).trim();
  if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) return null;
  return {
    name,
    raw: value,
    value: value.slice(separator + 1).trim(),
  };
}

function redactSecrets(value: string, headers: SensitiveHeader[]) {
  const secrets = headers.flatMap((header) => {
    const credential = header.value.replace(/^\S+\s+/, '');
    return [header.raw, header.value, credential];
  }).filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join('<redacted>'),
    value,
  );
}

export function sanitizedCurlDiagnostics(input: {
  binary: string;
  args: string[];
  stdout: string;
  stderr: string;
}) {
  const headers: SensitiveHeader[] = [];
  const args = [...input.args];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if ((argument === '-H' || argument === '--header') && index + 1 < args.length) {
      const header = sensitiveHeader(args[index + 1]);
      if (header) {
        headers.push(header);
        args[index + 1] = `${header.name}: <redacted>`;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--header=')) {
      const header = sensitiveHeader(argument.slice('--header='.length));
      if (header) {
        headers.push(header);
        args[index] = `--header=${header.name}: <redacted>`;
      }
    }
  }
  return {
    command: [input.binary, ...args],
    stdout: redactSecrets(input.stdout, headers),
    stderr: redactSecrets(input.stderr, headers),
  };
}
