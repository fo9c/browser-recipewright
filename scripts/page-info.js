// Whitelisted page script example. Runs in an isolated world (page scripts cannot see it).
// Must be a single function expression taking one argument (the step's "args").
(args) => {
  const se = document.scrollingElement || document.documentElement;
  return {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || null,
    scrollHeight: se.scrollHeight,
    links: args && args.countLinks ? document.querySelectorAll('a[href]').length : undefined,
  };
}
