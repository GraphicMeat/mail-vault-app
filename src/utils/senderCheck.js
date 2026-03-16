/**
 * Sender verification: checks for spoofing indicators.
 *
 * Returns: { status: 'verified'|'warning'|'danger'|'none', tooltip: string }
 */

function getDomain(email) {
  if (!email) return '';
  const parts = email.split('@');
  return (parts[1] || '').toLowerCase().trim();
}

/**
 * Parse Authentication-Results header for SPF/DKIM/DMARC results.
 */
export function parseAuthResults(header) {
  if (!header) return { spf: null, dkim: null, dmarc: null };

  const results = { spf: null, dkim: null, dmarc: null };

  const spfMatch = header.match(/\bspf=(pass|fail|softfail|neutral|none|temperror|permerror)\b/i);
  if (spfMatch) results.spf = spfMatch[1].toLowerCase();

  const dkimMatch = header.match(/\bdkim=(pass|fail|none|neutral|temperror|permerror)\b/i);
  if (dkimMatch) results.dkim = dkimMatch[1].toLowerCase();

  const dmarcMatch = header.match(/\bdmarc=(pass|fail|none|bestguesspass)\b/i);
  if (dmarcMatch) results.dmarc = dmarcMatch[1].toLowerCase();

  return results;
}

/**
 * Check sender verification for an email.
 *
 * @param {object} email - EmailHeader with from, replyTo, returnPath, authenticationResults
 * @returns {{ status: 'verified'|'warning'|'danger'|'none', tooltip: string }}
 */
export function checkSenderVerification(email) {
  if (!email?.from) return { status: 'none', tooltip: '' };

  const fromAddress = (email.from.address || '').toLowerCase().trim();
  const fromDomain = getDomain(fromAddress);
  const issues = [];

  // Layer 0: Display name impersonation detection
  const fromName = (email.from.name || '').trim();
  const fromNameLower = fromName.toLowerCase();
  if (fromName) {
    // Check if display name looks like an email address that differs from actual sender
    const nameIsEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromName);
    if (nameIsEmail && fromNameLower !== fromAddress) {
      const nameDomain = getDomain(fromNameLower);
      issues.push({
        level: 'danger',
        text: `Display name shows "${fromName}" but actual sender is ${email.from.address} — likely impersonation`,
        details: { displayName: fromName, actualAddress: email.from.address, displayDomain: nameDomain, actualDomain: fromDomain },
      });
    }

    // Check if display name looks like a domain (e.g., "ledger.com") that differs from sender domain
    const nameLooksDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(fromNameLower);
    if (!nameIsEmail && nameLooksDomain && fromNameLower !== fromDomain) {
      issues.push({
        level: 'warning',
        text: `Sender name "${fromName}" impersonates domain that differs from actual sender (${fromDomain})`,
        details: { displayName: fromName, actualDomain: fromDomain },
      });
    }
  }

  // Layer 1: Header mismatch detection
  // replyTo can be a single object { address } (from EmailHeader) or an array (from full Email)
  const replyToAddr = Array.isArray(email.replyTo)
    ? email.replyTo[0]?.address
    : (email.replyTo?.address || (typeof email.replyTo === 'string' ? email.replyTo : null));

  if (replyToAddr) {
    const replyToDomain = getDomain(replyToAddr);
    if (replyToDomain && replyToDomain !== fromDomain) {
      issues.push({
        level: 'warning',
        text: `Reply-To address (${replyToAddr}) differs from sender`,
      });
    }
  }

  if (email.returnPath) {
    const returnPathDomain = getDomain(email.returnPath);
    if (returnPathDomain && returnPathDomain !== fromDomain) {
      issues.push({
        level: 'info',
        text: `Return-Path domain (${returnPathDomain}) differs from sender domain`,
      });
    }
  }

  // Layer 2: Authentication results
  const auth = parseAuthResults(email.authenticationResults);
  const hasAuthHeaders = auth.spf !== null || auth.dkim !== null || auth.dmarc !== null;

  if (hasAuthHeaders) {
    const failures = [];
    if (auth.spf === 'fail' || auth.spf === 'softfail') failures.push('SPF');
    if (auth.dkim === 'fail') failures.push('DKIM');
    if (auth.dmarc === 'fail') failures.push('DMARC');

    if (failures.length > 0) {
      issues.push({
        level: 'danger',
        text: `Sender authentication failed (${failures.join(', ')}) — this email may be spoofed`,
      });
    }
  }

  // Determine overall status
  if (issues.some(i => i.level === 'danger')) {
    return {
      status: 'danger',
      tooltip: issues.map(i => i.text).join('\n'),
      issues,
    };
  }

  if (issues.some(i => i.level === 'warning')) {
    return {
      status: 'warning',
      tooltip: issues.map(i => i.text).join('\n'),
      issues,
    };
  }

  if (hasAuthHeaders && auth.spf === 'pass' && auth.dkim === 'pass') {
    return {
      status: 'verified',
      tooltip: 'Sender verified (SPF, DKIM pass)',
      issues: [],
    };
  }

  return { status: 'none', tooltip: '', issues: [] };
}
