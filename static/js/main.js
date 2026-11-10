  /* ============================================================
     Labmem 名鉴数据源
     · 追加角色：有 Labmem Number → LABMEM 末尾加一行；
                 无编号的相关者 → OTHERS 加一行。
     · 名鉴只讲作品设定，与站点内可用的造型数量无关，
       所以以后新增造型不需要改动这里。
     ============================================================ */
  var LABMEM = [
    { no: '001', jp: '岡部倫太郎', cn: '冈部伦太郎', role: '创立者 · 凤凰院凶真',
      desc: '未来道具研究所的创立者，自称「狂气的疯狂科学家」，总披着白大褂，动不动搬出「机关的阴谋」。也是唯一带着记忆跨越世界线的人。',
      tags: ['Labmem No.001', '未来道具研究所'] },
    { no: '002', jp: '椎名まゆり', cn: '椎名真由理', role: '青梅竹马',
      desc: '冈部的青梅竹马，爱缝制 cosplay 服装，一句「トゥットゥルー～」就是研究所的日常。最温柔的空气，也是所有世界线绕不开的那个人。',
      tags: ['トゥットゥルー', '手工部'] },
    { no: '003', jp: '橋田至', cn: '桥田至', role: '超级骇客 · ダル',
      desc: '冈部高中时代的友人，被唤作「ダル」的超级骇客。研究所的技术担当，把一堆破烂改造成编号齐全的「未来道具」。',
      tags: ['ダル', '未来道具'] },
    { no: '004', jp: '牧瀬紅莉栖', cn: '牧濑红莉栖', role: '天才变态少女 · 助手',
      desc: '年少便在学术期刊发表论文的天才，被冈部硬叫作「助手」。最早看穿电话微波炉秘密的人，也是理性与情感之间那道分岔。',
      tags: ['助手', 'Amadeus'] },
    { no: '005', jp: '桐生萌郁', cn: '桐生萌郁', role: '闪光的指压师',
      desc: '几乎只用手机短信交谈的沉默少女，打字快得被称作「闪光的指压师」。为寻找旧式计算机 IBN 5100 而接近研究所，手机里藏着不能说的指令。',
      tags: ['短信', 'IBN 5100'] },
    { no: '006', jp: '漆原るか', cn: '漆原琉华', role: '柳林神社的巫女',
      desc: '柳林神社的巫女，举止比谁都温顺，被冈部唤作「ルカ子」。一封想「变成女孩子」的 D-Mail，把心愿连同世界线一起拧紧。',
      tags: ['ルカ子', 'D-Mail'] },
    { no: '007', jp: 'フェイリス・ニャンニャン', cn: '菲利斯·喵喵', role: '柴郡猫的微笑',
      desc: '秋叶原女仆咖啡厅的招牌女仆，句尾总带「ニャン」，本名秋叶留未穗。《雷ネットアクセスバトラーズ》的高手，她发出的一封 D-Mail 改变了整条秋叶原。',
      tags: ['ニャン', '雷ネット'] },
    { no: '008', jp: '阿万音鈴羽', cn: '阿万音铃羽', role: '打工战士',
      desc: '骑着自行车出现在秋叶原的少女，在楼下显像管工房打工。自称从 2036 年而来，为改写被机关支配的未来四处奔走。',
      tags: ['2036', '显像管工房'] },
    { no: '009', jp: '比屋定真帆', cn: '比屋定真帆', role: '萝莉小学生',
      desc: '《STEINS;GATE 0》的世界线里，与红莉栖一同开发「Amadeus」的研究者。嘴上毫不留情，却比谁都放不下那个已不在的人。',
      tags: ['Amadeus', 'STEINS;GATE 0'] },
    { no: '010', jp: '椎名かがり', cn: '椎名篝', role: '真由理的养女',
      desc: '《0》的世界线里被真由理收养的少女，从未来被送回 2010 年。与真由理相似的面容下，藏着一段无法言说的旅程。',
      tags: ['养女', '未来'] },
    { no: '011', jp: '阿万音由季', cn: '阿万音由季', role: 'Cosplayer',
      desc: '《0》的世界线里桥田至未来的妻子、阿万音铃羽的母亲。开朗直率，总把「未来」说得像明天一样平常。',
      tags: ['铃羽的母亲', '未来'] }
  ];

  var OTHERS = [
    { jp: '天王寺綯', cn: '天王寺绹', role: '小动物',
      desc: '楼下显像管工房店主的女儿，常抱着东西跑上二楼的研究所，被大家当妹妹看待；在某些未来里，她背负着远超过年纪的事。',
      tags: ['研究所常客'] },
    { jp: '天王寺裕吾', cn: '天王寺裕吾', role: '显像管工房店主',
      desc: '一楼显像管工房的店主，被研究所成员称作「Mr. Braun」。爱显像管、爱女儿，来历却不止于此。',
      tags: ['Mr. Braun'] },
    { jp: '4℃', cn: '4℃', role: '「病毒攻击者」团伙头目',
      desc: '本名铃木功一,雷网对战池袋赛区代表，冈部的"严父"。因输给菲利斯·喵喵怀恨在心，后续指使手下施暴，最终被警方逮捕。冈部叫他「4度氏」',
      tags: ['Mr. Braun'] },
    { jp: '来嶋かえで', cn: '来岛枫', role: '真由理的好友',
      desc: '真由理的同班好友，也是研究所的常客。在《0》的世界线里，与真由理一起留下了许多平凡的日常。',
      tags: ['研究所常客'] },
    { jp: 'アレクシス・レスキネン', cn: '阿莱克西斯·莱斯金宁', role: '维克托·孔多利亚大学教授',
      desc: '《0》里主持「Amadeus」研究的教授，笑容温和，却把人的记忆与人格当作可以计算的数据。',
      tags: ['Amadeus'] }
  ];

  (function renderRoster() {
    function node(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function card(d, compact) {
      var a = node('article', 'chara' + (compact ? ' chara--compact' : ''));
      var head = node('div', 'chara-head');
      head.appendChild(node('span', 'chara-no' + (compact ? ' is-other' : ''),
                            compact ? '—' : 'No.' + d.no));
      head.appendChild(node('span', 'chara-name', d.jp));
      head.appendChild(node('span', 'chara-cn', d.cn));
      head.appendChild(node('span', 'chara-role', d.role));
      a.appendChild(head);
      a.appendChild(node('p', '', d.desc));
      var tags = node('div', 'chara-tags');
      d.tags.forEach(function (t) { tags.appendChild(node('span', 'chip', t)); });
      a.appendChild(tags);
      return a;
    }
    var numbered = document.getElementById('roster-labmem');
    var others = document.getElementById('roster-others');
    if (!numbered || !others) return;
    LABMEM.forEach(function (d) { numbered.appendChild(card(d, false)); });
    OTHERS.forEach(function (d) { others.appendChild(card(d, true)); });
    window.SG_ROSTER = { labmem: LABMEM, others: OTHERS };
  })();

  /* 页内 tab 高亮 */
  (function () {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab[data-section]'));
    var sections = tabs.map(function (t) { return document.getElementById(t.dataset.section); })
                       .filter(Boolean);
    function setActive(id) {
      tabs.forEach(function (t) {
        var on = t.dataset.section === id;
        t.classList.toggle('is-active', on);
        if (on) { t.setAttribute('aria-current', 'page'); }
        else { t.removeAttribute('aria-current'); }
      });
    }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { setActive(t.dataset.section); });
    });
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        var visible = entries.filter(function (e) { return e.isIntersecting; })
                             .sort(function (a, b) { return b.intersectionRatio - a.intersectionRatio; })[0];
        if (visible) { setActive(visible.target.id); }
      }, { rootMargin: '-22% 0px -62% 0px', threshold: [0, .15, .4] });
      sections.forEach(function (s) { io.observe(s); });
    }
  })();
