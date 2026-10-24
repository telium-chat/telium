import axe from 'axe-core';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

// jsdom has no canvas; region and heading-one do not apply to fragments.
const DISABLED = {
  'color-contrast': { enabled: false },
  region: { enabled: false },
  'page-has-heading-one': { enabled: false },
};

function target(subject) {
  if (!subject) return document.body;
  return subject.baseElement || subject.container || subject;
}

function describeViolation(violation) {
  const lines = [`  ${violation.id} (${violation.impact || 'unknown'} impact) -- ${violation.help}`];
  for (const node of violation.nodes) {
    lines.push(`    at: ${node.target.join(' ')}`);
    lines.push(`        ${node.html.replace(/\s+/g, ' ').slice(0, 160)}`);
    for (const line of (node.failureSummary || '').split('\n')) {
      if (line.trim()) lines.push(`        ${line.trim()}`);
    }
  }
  lines.push(`    why: ${violation.helpUrl}`);
  return lines.join('\n');
}

export async function expectNoViolations(subject, what, options = {}) {
  const results = await axe.run(target(subject), {
    resultTypes: ['violations'],
    runOnly: { type: 'tag', values: TAGS },
    rules: { ...DISABLED, ...(options.rules || {}) },
  });
  if (!results.violations.length) return;
  throw new Error([
    '',
    `${what} has ${results.violations.length} accessibility violation(s):`,
    '',
    ...results.violations.map(describeViolation),
    '',
  ].join('\n'));
}
