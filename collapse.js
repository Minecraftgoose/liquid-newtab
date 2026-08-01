// 控制面板板块折叠：默认全部收起，点击标题展开/收起
(function(){
  var groups = document.querySelectorAll('#panel .grp');
  groups.forEach(function(grp){
    var head = grp.querySelector('.gh');
    if(!head) return;
    // 把标题之后的内容包进 .grp-body（含之后可能追加的元素，用 while 移动）
    var body = document.createElement('div');
    body.className = 'grp-body';
    var n;
    while((n = head.nextElementSibling)) body.appendChild(n);
    grp.appendChild(body);
    // 点击标题切换展开
    head.addEventListener('click', function(){
      grp.classList.toggle('open');
    });
    // 默认折叠
    grp.classList.remove('open');
  });
})();
