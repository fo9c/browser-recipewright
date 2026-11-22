// Clicks nothing; reports how many "Show more" style truncation markers are visible, so a template
// can decide (with an if step) whether to click them. Read-only by design.
(args) => {
  const words = (args && args.words) || ['Show more', '显示更多', 'Read more'];
  const els = Array.from(document.querySelectorAll('button, [role=button], span, a'));
  return els.filter((e) => words.some((w) => (e.innerText || '').trim() === w)).length;
}
