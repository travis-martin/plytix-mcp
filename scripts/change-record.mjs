/** Platform-independent validation for the versioned change-record contract. */
export function validateChangeRecord(message, policy) {
  const errors = [];
  const lines = message.replace(/\r\n/g, '\n').trim().split('\n');
  const subject = lines[0] ?? '';
  const match = /^([a-z]+)\(([a-z0-9][a-z0-9._/-]*)\)(!)?: (\S.*)$/.exec(subject);
  if (!match || !policy.subject_types.includes(match[1])) {
    errors.push('Use type(scope): concrete summary with a supported Conventional Commit type.');
  }
  if (subject.length > 100) errors.push('Keep the subject at or below 100 characters.');
  const lastBlank = lines.lastIndexOf('');
  const trailerLines = lastBlank >= 1 ? lines.slice(lastBlank + 1) : [];
  const fields = new Map();
  for (const line of trailerLines) {
    const trailer = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line);
    if (!trailer) {
      errors.push('Use one Name: value line per trailer in the final block.');
      continue;
    }
    if (fields.has(trailer[1])) errors.push(`Duplicate trailer: ${trailer[1]}.`);
    fields.set(trailer[1], trailer[2].trim());
  }
  for (const name of policy.required_trailers) {
    const value = fields.get(name);
    if (!value) errors.push(`Missing nonempty ${name} trailer.`);
    else if (/replace-with|^todo\b|^tbd\b|^n\/?a$/i.test(value)) errors.push(`Replace the ${name} placeholder with factual content.`);
  }
  const changeId = fields.get('Change-Id');
  if (changeId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(changeId)) {
    errors.push('Change-Id must be a stable 8–128 character reference without spaces.');
  }
  return errors;
}
