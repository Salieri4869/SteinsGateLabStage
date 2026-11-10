  /* 动效控制器：两态开关（关 / 开），状态存 localStorage。
     默认在系统开启「减少动态效果」时为「关」，用户可显式覆盖。
     所有效果都只在 html.sg-fx-on 下由 CSS 生效；本脚本不触碰 topbar。
     页面加载（刷新）时不播放任何闪帧或快切，动效只由滚动 / 点击 / 悬停触发。 */
  (function () {
    var root = document.documentElement;
    var KEY = 'sg-fx-level';
    var btn = document.getElementById('sg-fx-toggle');
    var reduce = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var level = 1;                                  // 0 关 / 1 开
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === '0') level = 0;
      // 旧版本曾存过 '2'（已移除的加强档），合并为「开」，避免老用户开关失灵
      else if (saved === '1' || saved === '2') level = 1;
      else if (reduce) level = 0;
    } catch (_) { if (reduce) level = 0; }

    var REVEAL = '.worldview .card, .sec-head, .roster-group, .chara, .roster-note, ' +
                 '.tech-cards .card, .tech-list li, .note, .tech-sign, footer';
    var revealIO = null, armed = false, glitchTimer = 0, resetTimer = 0;

    /* 待入场元素只在 JS 成功挂载观察器后才隐藏，脚本失效时内容照常可见 */
    function armReveal() {
      if (armed) return;
      armed = true;
      var els = [].slice.call(document.querySelectorAll(REVEAL));
      els.forEach(function (el) { el.classList.add('fx-reveal'); });
      els.forEach(function (el) {
        var sibs = el.parentElement ? [].filter.call(el.parentElement.children,
          function (c) { return c.classList.contains('fx-reveal'); }) : [];
        var i = Math.max(0, sibs.indexOf(el));
        el.style.setProperty('--fx-d', (Math.min(i, 5) * 65) + 'ms');
      });
      function done(el) {
        el.classList.remove('fx-reveal', 'is-in');
        el.style.removeProperty('--fx-d');
      }
      if (!('IntersectionObserver' in window)) {
        els.forEach(done);
        return;
      }
      revealIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var el = e.target;
          revealIO.unobserve(el);
          el.classList.add('is-in');
          el.addEventListener('animationend', function () { done(el); }, { once: true });
          // 后台标签页 / 动画被浏览器暂停时，兜底把元素恢复成可见
          setTimeout(function () { done(el); }, 1200);
        });
      }, { rootMargin: '0px', threshold: 0 });
      els.forEach(function (el) { revealIO.observe(el); });
    }
    function disarmReveal() {
      [].forEach.call(document.querySelectorAll('.fx-reveal'), function (el) {
        el.classList.remove('fx-reveal', 'is-in');
        el.style.removeProperty('--fx-d');
      });
      if (revealIO) { revealIO.disconnect(); revealIO = null; }
      armed = false;
    }

    /* 变动率仪表数字抖动（只作用于 hero 内的仪表，导航里的数字保持原样） */
    var meters = [].slice.call(document.querySelectorAll('.div-meter b'));
    function rollDigits() {
      meters.forEach(function (el) {
        var base = el.getAttribute('data-sg-base');
        if (base == null) { base = el.textContent.trim(); el.setAttribute('data-sg-base', base); }
        var chars = base.split('');
        for (var n = 0; n < 3; n++) {
          var k = Math.floor(Math.random() * chars.length);
          if (chars[k] >= '0' && chars[k] <= '9') chars[k] = String(Math.floor(Math.random() * 10));
        }
        el.textContent = chars.join('');
        setTimeout(function () { el.textContent = base; }, 130);
      });
    }

    function burst() {
      if (!level || document.hidden) return;
      root.classList.add('sg-glitch');
      rollDigits();
      clearTimeout(resetTimer);
      resetTimer = setTimeout(function () { root.classList.remove('sg-glitch'); }, 240);
    }

    /* 切换章节时来一记剪辑点：只做 RGB 分离 + 数字抖动，不再全屏闪白 */
    function cut() {
      if (!level) return;
      burst();
    }

    function apply() {
      root.classList.toggle('sg-fx-on', level > 0);
      if (btn) {
        btn.setAttribute('aria-pressed', String(level > 0));
        btn.querySelector('span').textContent = level ? 'ON' : 'OFF';
        btn.title = level ? 'FX 动效：开（点击关闭）' : 'FX 动效：关（点击开启）';
      }
      clearInterval(glitchTimer);
      if (level) {
        armReveal();
        glitchTimer = setInterval(burst, 9000);
      } else {
        disarmReveal();
        root.classList.remove('sg-glitch');
      }
    }

    document.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.tab[data-section]')) cut();
    }, true);

    if (btn) btn.addEventListener('click', function () {
      level = level ? 0 : 1;
      try { localStorage.setItem(KEY, String(level)); } catch (_) {}
      apply();
    });
    apply();
  })();
