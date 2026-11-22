// Demo site that imitates the *structure* of an infinite social feed (data-testid attributes,
// virtualized list, "1.2K" like counts) so templates can be tested offline. All content is generated.
(function () {
  function rng(seed) {
    let h = 2166136261;
    for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return function () {
      h += 0x6d2b79f5;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const WORDS = ['agent', 'browser', 'workflow', 'template', 'replay', 'record', 'repair', 'locator', 'scroll', 'feed', 'today', 'great', 'idea', 'ship', 'test', 'fast', 'stable', 'demo', 'open', 'source'];
  const NAMES = ['Ada', 'Lin', 'Kai', 'Mei', 'Ravi', 'Sora', 'Noor', 'Yuki', 'Omar', 'Zoe', 'Ivan', 'Lea'];
  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    if (n >= 1e3) return n.toLocaleString('en-US');
    return String(n);
  }
  function makePost(seed, i, q) {
    const r = rng(seed + ':' + i);
    const name = NAMES[Math.floor(r() * NAMES.length)];
    const handle = name.toLowerCase() + Math.floor(r() * 90 + 10);
    const id = String(1000000 + Math.floor(r() * 8999999)) + String(i).padStart(3, '0');
    const n = 6 + Math.floor(r() * 14);
    const words = [];
    for (let k = 0; k < n; k++) words.push(WORDS[Math.floor(r() * WORDS.length)]);
    if (q) words.splice(Math.floor(r() * words.length), 0, q);
    const roll = r();
    const likes = roll < 0.15 ? 0 : roll < 0.6 ? Math.floor(r() * 60) : roll < 0.9 ? Math.floor(r() * 3000) : Math.floor(r() * 90000);
    return { name, handle, id, text: words.join(' '), likes, hoursAgo: i + 1, hasText: r() > 0.05 };
  }
  function postHtml(p) {
    const like = p.likes ? fmt(p.likes) + ' Likes. Like' : 'Like';
    return (
      '<article data-testid="tweet" role="article" class="post">' +
      '<div class="head"><div data-testid="User-Name"><b>' + p.name + '</b> <span>@' + p.handle + '</span></div>' +
      '<a href="/' + p.handle + '/status/' + p.id + '"><time datetime="' + new Date(Date.UTC(2026, 10, 22, 12) - p.hoursAgo * 3600e3).toISOString() + '">' + p.hoursAgo + 'h</time></a></div>' +
      (p.hasText ? '<div data-testid="tweetText" lang="en">' + p.text + '</div>' : '<div class="media">[image]</div>') +
      '<div class="actions"><button data-testid="reply" aria-label="Reply">💬</button>' +
      '<button data-testid="like" aria-label="' + like + '">♡ <span>' + (p.likes ? fmt(p.likes) : '') + '</span></button></div>' +
      '</article>'
    );
  }
  // Infinite, virtualized list: items far above the viewport are removed (like real feeds do).
  function infiniteList(container, total, pageSize, make) {
    let rendered = 0, loading = false, removedHeight = 0;
    const spacer = document.createElement('div');
    container.before(spacer);
    function more() {
      if (loading || rendered >= total) return;
      loading = true;
      const end = Math.min(total, rendered + pageSize);
      const delay = rendered === 0 ? 50 : 250 + Math.random() * 350;
      setTimeout(function () {
        let html = '';
        for (let i = rendered; i < end; i++) html += make(i);
        container.insertAdjacentHTML('beforeend', html);
        rendered = end;
        loading = false;
        document.getElementById('status-line').textContent = rendered >= total ? 'End of results' : 'Loaded ' + rendered;
      }, delay);
    }
    function onScroll() {
      const se = document.scrollingElement;
      if (se.scrollTop + innerHeight > se.scrollHeight - 900) more();
      // virtualize
      let first = container.firstElementChild;
      while (first && first.getBoundingClientRect().bottom < -2500) {
        removedHeight += first.getBoundingClientRect().height + 1;
        spacer.style.height = removedHeight + 'px';
        first.remove();
        first = container.firstElementChild;
      }
    }
    addEventListener('scroll', onScroll, { passive: true });
    more();
  }
  function requireLogin() {
    if (localStorage.getItem('loggedIn') !== '1') {
      document.body.innerHTML = '<main style="padding:40px"><h1>Please log in</h1><a href="/home.html">Go to login</a></main>';
      return false;
    }
    return true;
  }
  window.Demo = { rng, makePost, postHtml, infiniteList, requireLogin, fmt };
})();
