export type PortalCredentialPayload = {
  fullName: string;
  email: string;
  password: string;
  role: string;
  companyName?: string | null;
  departmentName?: string | null;
  isNewLogin: boolean;
};

export function portalLoginUrl(): string {
  const fromEnv =
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_APP_URL?.trim() : undefined;
  const origin =
    fromEnv?.replace(/\/$/, '') ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  return `${origin}/auth`;
}

export function portalRoleLabel(role: string): string {
  switch (role) {
    case 'CEO':
      return 'CEO portal';
    case 'HEAD':
      return 'Manager portal';
    case 'EMPLOYEE':
      return 'Employee portal';
    default:
      return 'Company portal';
  }
}

function formatGeneratedAt(): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());
}

function credentialLines(payload: PortalCredentialPayload): string[] {
  const lines = [
    'Company Portal Login Credentials',
    '================================',
    '',
  ];
  if (payload.companyName?.trim()) {
    lines.push(`Company: ${payload.companyName.trim()}`);
  }
  lines.push(`Portal: ${portalRoleLabel(payload.role)}`);
  if (payload.departmentName?.trim()) {
    lines.push(`Department: ${payload.departmentName.trim()}`);
  }
  lines.push(`Name: ${payload.fullName.trim() || payload.email}`);
  lines.push('');
  lines.push(`Login URL: ${portalLoginUrl()}`);
  lines.push(`Email: ${payload.email}`);
  lines.push(`Password: ${payload.password}`);
  lines.push('');
  lines.push('Sign in with the email and password above. You can change your password later in Settings.');
  lines.push('');
  lines.push('Keep this information secure. Share only with the intended recipient.');
  lines.push(`Generated: ${formatGeneratedAt()}`);
  return lines;
}

export function buildCredentialsText(payload: PortalCredentialPayload): string {
  return credentialLines(payload).join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildCredentialsHtml(payload: PortalCredentialPayload): string {
  const title = payload.isNewLogin ? 'Portal login created' : 'Portal password updated';
  const rows: Array<[string, string]> = [
    ['Portal', portalRoleLabel(payload.role)],
    ['Name', payload.fullName.trim() || payload.email],
    ['Email', payload.email],
    ['Password', payload.password],
    ['Login URL', portalLoginUrl()],
  ];
  if (payload.companyName?.trim()) {
    rows.unshift(['Company', payload.companyName.trim()]);
  }
  if (payload.departmentName?.trim()) {
    rows.splice(payload.companyName?.trim() ? 2 : 1, 0, ['Department', payload.departmentName.trim()]);
  }

  const tableRows = rows
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
      margin: 0;
      padding: 40px;
      line-height: 1.5;
    }
    .card {
      max-width: 640px;
      margin: 0 auto;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 32px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 22px;
    }
    .subtitle {
      margin: 0 0 24px;
      color: #475569;
      font-size: 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: top;
      font-size: 14px;
    }
    th {
      width: 140px;
      color: #64748b;
      font-weight: 600;
    }
    td { font-weight: 500; word-break: break-word; }
    .note {
      font-size: 12px;
      color: #64748b;
      border-top: 1px solid #e2e8f0;
      padding-top: 16px;
    }
    @media print {
      body { padding: 0; }
      .card { border: none; border-radius: 0; }
      .no-print { display: none !important; }
    }
    .toolbar {
      max-width: 640px;
      margin: 0 auto 16px;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .toolbar button {
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid #c7d2fe;
      background: #4f46e5;
      color: #fff;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">Share these details securely with ${escapeHtml(payload.fullName.trim() || payload.email)}.</p>
    <table>${tableRows}</table>
    <p class="note">Sign in with the email and password above. The user can change their password later in Settings.<br />
    Generated ${escapeHtml(formatGeneratedAt())}.</p>
  </div>
  <script>
    window.addEventListener('load', function () {
      window.setTimeout(function () { window.print(); }, 300);
    });
  </script>
</body>
</html>`;
}

function credentialEntries(payload: PortalCredentialPayload): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Portal', portalRoleLabel(payload.role)],
    ['Name', payload.fullName.trim() || payload.email],
    ['Email', payload.email],
    ['Password', payload.password],
    ['Login URL', portalLoginUrl()],
  ];
  if (payload.companyName?.trim()) {
    rows.unshift(['Company', payload.companyName.trim()]);
  }
  if (payload.departmentName?.trim()) {
    rows.splice(payload.companyName?.trim() ? 2 : 1, 0, ['Department', payload.departmentName.trim()]);
  }
  return rows;
}

function credentialsFileStem(email: string): string {
  return email.replace(/[^a-z0-9@._-]+/gi, '_').slice(0, 64);
}

/** Downloads a real .pdf file (one-click, no print dialog). */
export async function downloadCredentialsPdfFile(payload: PortalCredentialPayload): Promise<boolean> {
  try {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 48;
    let y = margin;
    const pageWidth = doc.internal.pageSize.getWidth();
    const valueX = margin + 108;
    const valueWidth = pageWidth - valueX - margin;
    const title = payload.isNewLogin ? 'Portal login created' : 'Portal password updated';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text(title, margin, y);
    y += 28;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(71, 85, 105);
    const subtitle = `Share these details securely with ${payload.fullName.trim() || payload.email}.`;
    doc.text(doc.splitTextToSize(subtitle, pageWidth - margin * 2), margin, y);
    y += 28;

    doc.setTextColor(15, 23, 42);
    for (const [label, value] of credentialEntries(payload)) {
      if (y > 720) {
        doc.addPage();
        y = margin;
      }
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(100, 116, 139);
      doc.text(`${label}:`, margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(15, 23, 42);
      const lines = doc.splitTextToSize(value, valueWidth);
      doc.text(lines, valueX, y);
      y += Math.max(18, lines.length * 14) + 8;
    }

    y += 8;
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    const foot =
      'Sign in with the email and password above. The user can change their password later in Settings.';
    doc.text(doc.splitTextToSize(foot, pageWidth - margin * 2), margin, y);
    y += 24;
    doc.text(`Generated ${formatGeneratedAt()}.`, margin, y);

    doc.save(`portal-credentials-${credentialsFileStem(payload.email)}.pdf`);
    return true;
  } catch {
    return false;
  }
}

export function downloadCredentialsTextFile(payload: PortalCredentialPayload): void {
  const blob = new Blob([buildCredentialsText(payload)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `portal-credentials-${credentialsFileStem(payload.email)}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function printHtmlDocument(html: string): boolean {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(iframe);
  const frameWin = iframe.contentWindow;
  const frameDoc = frameWin?.document;
  if (!frameWin || !frameDoc) {
    iframe.remove();
    return false;
  }
  frameDoc.open();
  frameDoc.write(html);
  frameDoc.close();
  frameWin.focus();
  frameWin.print();
  window.setTimeout(() => iframe.remove(), 1500);
  return true;
}

/** Opens a printable preview tab (optional fallback). */
export function openCredentialsPrintWindow(payload: PortalCredentialPayload): boolean {
  const html = buildCredentialsHtml(payload);
  return printHtmlDocument(html);
}

export async function copyCredentialsToClipboard(payload: PortalCredentialPayload): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(buildCredentialsText(payload));
    return true;
  } catch {
    return false;
  }
}
