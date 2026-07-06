/**
 * Tiny CSV helpers for institutional-style data export. No dependencies; RFC-4180
 * quoting (double quotes, doubled inner quotes). Client-side download via a Blob.
 */

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    let s = String(v);
    // Formula-injection guard: a cell beginning with = + - @ (or a leading tab/CR)
    // is executed as a formula by Excel/Sheets on open. Neutralize by prefixing a
    // single quote. RFC-4180 quoting alone does NOT prevent this. (Audit web M1.)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(",")];
  for (const row of rows) lines.push(row.map(esc).join(","));
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
