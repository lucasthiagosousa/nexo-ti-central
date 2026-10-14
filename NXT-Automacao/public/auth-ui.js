(function () {
  "use strict";

  function ensureGlobalFavicon() {
    var iconPath = "/favicon.ico?v=1.3.1";
    var links = document.querySelectorAll('link[rel="icon"],link[rel="shortcut icon"]');
    if (!links.length) {
      var icon = document.createElement("link");
      icon.rel = "icon";
      icon.type = "image/x-icon";
      document.head.appendChild(icon);
      links = [icon];
    }
    Array.from(links).forEach(function (link) {
      link.href = iconPath;
      link.type = "image/x-icon";
    });
    var apple = document.querySelector('link[rel="apple-touch-icon"]');
    if (!apple) {
      apple = document.createElement("link");
      apple.rel = "apple-touch-icon";
      document.head.appendChild(apple);
    }
    apple.href = "/assets/nexo-ti-icon.svg";
  }
  ensureGlobalFavicon();

  const ROLE_LABELS = { master: "Master Admin", operator: "Operador", viewer: "Visualizador" };
  const WORKSPACE_PAGES = ["/central.html", "/inteligencia.html", "/atividades.html", "/", "/index.html", "/identificadores.html", "/toner.html", "/toner-operacao.html", "/colaboradores.html"];

  window.addEventListener("pageshow", function (event) {
    if (event.persisted) window.location.reload();
  });

  const WORKSPACE_USER_CACHE = "nxt-workspace-user";

  function cachedWorkspaceUser() {
    try {
      const value = JSON.parse(sessionStorage.getItem(WORKSPACE_USER_CACHE) || "null");
      return value && value.username ? value : null;
    } catch {
      return null;
    }
  }

  function cacheWorkspaceUser(user) {
    try { sessionStorage.setItem(WORKSPACE_USER_CACHE, JSON.stringify(user)); } catch {}
  }

  async function requestUser() {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    if (response.status === 401) {
      try { sessionStorage.removeItem(WORKSPACE_USER_CACHE); } catch {}
      window.location.replace("/login.html");
      throw new Error("Sessão expirada.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.mensagem || "Não foi possível validar a sessão.");
    cacheWorkspaceUser(result.user);
    return result.user;
  }

  function addStyles() {
    const style = document.createElement("style");
    style.textContent = `
      [hidden]{display:none!important}
      html,body,button,input,select,textarea{font-family:"Segoe UI Variable Text","Segoe UI",Tahoma,Arial,sans-serif!important;text-shadow:none!important;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
      body{font-weight:400!important}
      p,span,label,input,select,textarea,td,li,small{font-weight:400!important;text-shadow:none!important}
      h1,h2,h3,h4,h5,h6{font-weight:600!important;text-shadow:none!important;letter-spacing:-.012em}
      strong,b{font-weight:600!important;text-shadow:none!important}
      button,.btn,[role="button"],.workspace-utility-link{font-weight:500!important;text-shadow:none!important}
      th,.eyebrow,.kicker,.label,.badge,.status{font-weight:600!important;text-shadow:none!important}
      .auth-account{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:5px 9px;border:1px solid rgba(255,255,255,.22);border-radius:10px;color:inherit;background:rgba(255,255,255,.1)}
      .auth-avatar{width:27px;height:27px;display:grid;place-items:center;border-radius:8px;background:#fff;color:#087a45;font-size:11px;font-weight:900}
      .auth-copy{display:flex;flex-direction:column;line-height:1.15;text-align:left}.auth-copy strong{font-size:11px}.auth-copy span{font-size:9px;opacity:.72}.auth-link{cursor:pointer;text-decoration:none}
      .workspace-utility-link{min-height:38px!important;padding:7px 11px!important;display:inline-flex!important;align-items:center!important;gap:7px!important;border:1px solid rgba(255,255,255,.25)!important;border-radius:10px!important;background:rgba(255,255,255,.1)!important;color:#fff!important;font-size:10px!important;font-weight:500!important;line-height:1!important;box-shadow:inset 0 1px rgba(255,255,255,.07)!important;transition:background .16s,border-color .16s,transform .16s!important}
      .workspace-utility-link svg{width:16px!important;height:16px!important;flex:0 0 16px;max-width:none!important}
      .workspace-utility-link:hover{background:rgba(255,255,255,.18)!important;border-color:rgba(255,255,255,.42)!important;transform:translateY(-1px)}
      .workspace-utility-link:focus-visible{outline:2px solid #6df0aa!important;outline-offset:2px}
      body.workspace-operational{font-weight:400!important}
      body.workspace-operational p,body.workspace-operational td,body.workspace-operational input,body.workspace-operational select,body.workspace-operational textarea,body.workspace-operational .meta,body.workspace-operational .muted,body.workspace-operational .panel-desc,body.workspace-operational .kpi-sub{font-weight:400!important}
      body.workspace-operational label,body.workspace-operational th{font-weight:500!important}
      body.workspace-operational button,body.workspace-operational .btn{font-weight:500!important}
      body.workspace-operational .pill,body.workspace-operational .badge,body.workspace-operational .status,body.workspace-operational .pending strong,body.workspace-operational .notice strong,body.workspace-operational .task strong,body.workspace-operational td strong{font-weight:500!important}
      body.workspace-operational h1,body.workspace-operational h2,body.workspace-operational h3,body.workspace-operational .panel-title{font-weight:600!important}body.workspace-operational main strong{font-weight:600!important}body.workspace-operational{font-synthesis:none!important}
      body.workspace-operational .kpi-value,body.workspace-operational .metric-value{font-weight:700!important}
      body.workspace-operational .brand strong,body.workspace-operational .auth-copy strong{font-weight:600!important}
      body.workspace-operational{--workspace-navy:#00180c;--workspace-navy-2:#04351c;--workspace-teal:#087a45;--workspace-line:#dce5ee;--workspace-blue:#08a85d;background:radial-gradient(1050px 430px at 88% -70px,rgba(0,198,92,.16) 0%,rgba(223,244,233,.48) 39%,transparent 68%),linear-gradient(180deg,#edf6f1 0,#f3f6fa 300px,#f3f6fa 100%)!important;background-attachment:fixed!important;color:#172b3f}
      body.workspace-operational .header{position:relative;isolation:isolate;top:auto;padding:0!important;overflow:hidden!important;background:linear-gradient(112deg,#001109 0%,#042b17 52%,#087a45 100%)!important;color:#fff!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important}
      body.workspace-operational .header:before{content:"";position:absolute;z-index:-1;width:520px;height:520px;right:-130px;top:-390px;border-radius:50%;background:rgba(0,255,119,.18);filter:blur(2px)}
      body.workspace-operational .header:after{display:none!important}body.workspace-operational .content{margin:0 auto!important;padding-top:22px!important}
      body.workspace-operational .header-inner{width:calc(100% - 48px)!important;max-width:none!important;margin:auto!important;padding:18px 0!important}
      body.workspace-operational .header .brand p,body.workspace-operational .header .brand-subtitle{color:rgba(255,255,255,.72)!important}
      body.workspace-operational .header .brand-icon,body.workspace-operational .header .mark{border:1px solid rgba(255,255,255,.27)!important;background:rgba(255,255,255,.11)!important;color:#fff!important;box-shadow:none!important}
      body.workspace-operational .header .btn-header{border-color:rgba(255,255,255,.25)!important;background:rgba(255,255,255,.1)!important;color:#fff!important;box-shadow:none!important}
      body.workspace-operational .header .btn-header:hover{background:rgba(255,255,255,.18)!important;border-color:rgba(255,255,255,.4)!important}
      body.workspace-operational .workspace-tabs-shell{position:relative;z-index:4;background:linear-gradient(112deg,#001109 0%,#042b17 52%,#087a45 100%);border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(0,86,42,.28);box-shadow:0 12px 28px rgba(0,48,24,.16)}body.workspace-operational .workspace-tabs-shell:after{content:"";position:absolute;left:0;right:0;bottom:-18px;height:18px;pointer-events:none;background:linear-gradient(180deg,rgba(0,180,83,.10),transparent)}
      .workspace-tabs{width:calc(100% - 48px);max-width:none;height:58px;margin:auto;display:flex;align-items:center;gap:8px;overflow-x:auto;scrollbar-width:none;transition:opacity .2s ease,transform .24s cubic-bezier(.22,.8,.24,1)}.workspace-tabs::-webkit-scrollbar{display:none}.workspace-tabs-shell.access-loading .workspace-tabs{opacity:0;transform:translateY(3px);pointer-events:none}.workspace-tabs-shell.access-ready .workspace-tabs{opacity:1;transform:none}.workspace-tabs-loader{position:absolute;inset:0;display:flex;align-items:center;gap:10px;width:calc(100% - 48px);height:58px;margin:auto;pointer-events:none;transition:opacity .18s ease}.workspace-tabs-loader span{display:block;width:118px;height:35px;border-radius:10px;background:linear-gradient(90deg,rgba(255,255,255,.035),rgba(255,255,255,.11),rgba(255,255,255,.035));background-size:220% 100%;animation:workspace-loader 1.1s ease-in-out infinite}.workspace-tabs-loader span:nth-child(2){width:138px;animation-delay:.08s}.workspace-tabs-loader span:nth-child(3){width:126px;animation-delay:.16s}@keyframes workspace-loader{to{background-position:-220% 0}}
      .workspace-tab{height:39px;padding:0 14px;display:inline-flex;align-items:center;gap:8px;border:1px solid transparent;border-radius:11px;color:rgba(231,242,250,.7);font-size:11px;font-weight:550;text-decoration:none;white-space:nowrap;transition:background .16s,border-color .16s,color .16s,transform .16s}
      .workspace-tab svg{width:17px;height:17px}.workspace-tab:hover{background:rgba(255,255,255,.09);color:#fff;transform:translateY(-1px)}.workspace-tab.active{border-color:rgba(72,236,147,.38);background:rgba(15,201,101,.18);color:#fff;box-shadow:inset 0 1px rgba(255,255,255,.08),0 5px 14px rgba(0,0,0,.1)}
      .workspace-tab-copy{display:flex;flex-direction:column;line-height:1.12}.workspace-tab-copy small{margin-top:2px;color:rgba(199,235,215,.55);font-size:8px;font-weight:500}.workspace-tab.active small{color:rgba(220,255,235,.78)}
      body.workspace-page-stock .content{max-width:1460px!important}body.workspace-page-stock .kpi,body.workspace-page-stock .panel,body.workspace-page-toner .kpi,body.workspace-page-toner .panel,body.workspace-page-colaboradores .card,body.workspace-page-colaboradores .table-wrap{border-color:#dde5ed!important;box-shadow:0 8px 26px rgba(19,45,68,.055)!important}
      .workspace-page-heading{margin:1px 0 18px;padding:2px 1px;display:flex;align-items:flex-end;justify-content:space-between;gap:20px}.workspace-page-heading span{display:block;margin-bottom:6px;color:#078b4e;font-size:9px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.workspace-page-heading h2{margin:0;color:#102f4a;font-size:25px;font-weight:600;letter-spacing:-.035em}.workspace-page-heading p{max-width:580px;margin:0;color:#718096;font-size:10px;line-height:1.6;text-align:right}
      body.workspace-page-toner{--blue:#1769e0!important;--text:#172b3f!important;--muted:#718096!important;--line:#dce5ee!important;background:#f3f6fa!important;background-image:radial-gradient(750px 320px at 94% -10%,#d9f2f4,transparent 65%)!important}
      body.workspace-page-toner .page{max-width:1460px!important}body.workspace-page-toner .kpi{border-top:1px solid #dde5ed!important;border-left:4px solid #1769e0!important}body.workspace-page-toner .kpi:nth-child(2){border-left-color:#10aab8!important}body.workspace-page-toner .kpi:nth-child(3){border-left-color:#e5484d!important}body.workspace-page-toner .kpi:nth-child(4){border-left-color:#e79b24!important}body.workspace-page-toner .kpi:nth-child(5){border-left-color:#748197!important}
      body.workspace-page-toner .card:before{background:#748197}body.workspace-page-toner .card:has(.badge-ok):before,body.workspace-page-toner .card:has(.badge-online):before{background:#10a36d}body.workspace-page-toner .card:has(.badge-warning):before{background:#e79b24}body.workspace-page-toner .card:has(.badge-critical):before{background:#e5484d}
      body.workspace-page-toner .toolbar{display:flex!important;grid-template-columns:none!important;align-items:center;flex-wrap:wrap;gap:9px}body.workspace-page-toner .toolbar #search{flex:1 1 390px;min-width:220px}body.workspace-page-toner .toolbar #status{flex:0 1 190px;width:190px}body.workspace-page-toner .toolbar .btn{flex:0 0 auto;width:auto!important;white-space:nowrap}body.workspace-page-toner .btn-pdf{background:#0b3553!important;border-color:#0b3553!important;color:#fff!important}
      body.workspace-page-colaboradores{padding:0!important}body.workspace-page-colaboradores .wrap{max-width:none!important;width:100%!important;margin:0!important}
      body.workspace-page-colaboradores .wrap>header{position:relative;isolation:isolate;overflow:hidden;width:100%;margin:0!important;padding:18px 24px;align-items:center;background:linear-gradient(112deg,#001109 0%,#042b17 52%,#087a45 100%);color:#fff}
      body.workspace-page-colaboradores .wrap>header:before{content:"";position:absolute;z-index:-1;width:520px;height:520px;right:-130px;top:-390px;border-radius:50%;background:rgba(0,255,119,.18);filter:blur(2px)}
      body.workspace-page-colaboradores .wrap>header .brand p{color:rgba(255,255,255,.72)}body.workspace-page-colaboradores .brand-mark{border:1px solid rgba(255,255,255,.27);background:rgba(255,255,255,.11);box-shadow:none}
      body.workspace-page-colaboradores .brand-mark svg{width:21px;height:21px}
      body.workspace-page-colaboradores .header-right .back-link{border-color:rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;box-shadow:none}
      body.workspace-page-colaboradores .status-pill{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.09);color:rgba(255,255,255,.8)}
      body.workspace-page-colaboradores .workspace-tabs-shell{width:100%;margin:0 0 26px}
      body.workspace-page-colaboradores .wrap>.intro,body.workspace-page-colaboradores .wrap>#dropzone,body.workspace-page-colaboradores .wrap>#app,body.workspace-page-colaboradores .wrap>footer{width:min(calc(100% - 48px),1280px)!important;margin-left:auto!important;margin-right:auto!important}body.workspace-page-colaboradores .wrap>.intro{margin-top:0!important;margin-bottom:16px!important}
      body.workspace-operational a[data-old-workspace-link]{display:none!important}
      @media(min-width:901px){body.workspace-operational{zoom:1!important}}
            @media(max-width:1328px){body.workspace-page-colaboradores .wrap>header{padding-left:24px;padding-right:24px}}
      @media(max-width:900px){body.workspace-operational .header-inner,body.workspace-page-colaboradores .wrap>header{align-items:flex-start!important;flex-direction:column!important}.header-actions,.header-right{width:100%;justify-content:flex-start!important}.workspace-tabs{width:calc(100% - 24px);height:55px}.workspace-tab{padding:0 12px}.workspace-tab-copy small{display:none}.workspace-page-heading{align-items:flex-start;flex-direction:column;gap:7px}.workspace-page-heading p{text-align:left}}
      /* Identidade verde global: ações e estados interativos */
      body.workspace-operational{--blue:#0aad63!important;--accent:#0aad63!important;--accent-dim:#e4f8ee!important}
      body.workspace-operational .content .btn-primary,body.workspace-operational main .btn-primary,body.workspace-operational .modal .btn-primary,body.workspace-operational #saveVacationPlan{border-color:#0a9b59!important;background:linear-gradient(135deg,#12cc78,#079854)!important;color:#fff!important;box-shadow:0 7px 18px rgba(5,143,79,.18)!important}
      body.workspace-operational .content .btn-primary:hover,body.workspace-operational main .btn-primary:hover,body.workspace-operational .modal .btn-primary:hover{background:linear-gradient(135deg,#18d982,#087f49)!important;transform:translateY(-1px)}
      body.workspace-operational .btn-soft,body.workspace-operational .btn-action{border-color:#bce8d2!important;background:#f3fcf7!important;color:#087747!important}
      body.workspace-operational .btn-soft:hover,body.workspace-operational .btn-action:hover{border-color:#7bd5a7!important;background:#e6f8ef!important}
      body.workspace-operational input:focus,body.workspace-operational select:focus,body.workspace-operational textarea:focus,body.workspace-operational .control:focus{border-color:#35b97b!important;box-shadow:0 0 0 3px rgba(10,173,99,.11)!important;outline:none!important}
      body.workspace-operational input[type="checkbox"],body.workspace-operational input[type="radio"]{accent-color:#0aad63!important}
      body.workspace-operational .result-count,body.workspace-operational .count,body.workspace-operational .access-tag{background:#e4f8ee!important;color:#087747!important;border-color:#bce8d2!important}
      body.workspace-operational .code,body.workspace-operational .browse,body.workspace-operational .workspace-page-heading span{color:#088b50!important}
      body.workspace-page-colaboradores .tab.active,body.workspace-page-colaboradores .chip.active{border-color:#0aad63!important;background:#0aad63!important;color:#fff!important;box-shadow:0 6px 16px rgba(10,173,99,.18)!important}
      body.workspace-page-colaboradores #dropzone:hover,body.workspace-page-colaboradores #dropzone.drag{border-color:#29b974!important;background:#f1fbf6!important}
      body.workspace-operational ::selection{background:#bdebd2;color:#063e25}
      .btn-primary{border-color:#0a9b59!important;background:linear-gradient(135deg,#12cc78,#079854)!important;color:#fff!important}
      @media(max-width:560px){body.workspace-operational .header-inner,.workspace-tabs{width:calc(100% - 24px)!important}body.workspace-page-colaboradores .wrap>.intro,body.workspace-page-colaboradores .wrap>#dropzone,body.workspace-page-colaboradores .wrap>#app,body.workspace-page-colaboradores .wrap>footer{width:calc(100% - 24px)!important}body.workspace-page-toner .toolbar #search,body.workspace-page-toner .toolbar #status,body.workspace-page-toner .toolbar .btn{flex:1 1 100%;width:100%!important}.auth-copy{display:none}.auth-account{padding:5px}.header-actions,.header-right{gap:6px!important}.header-actions>.btn,.header-right>.btn,.header-right>.back-link{min-height:36px!important;padding:7px 9px!important;font-size:10px!important}.workspace-tabs{gap:4px}.workspace-tab{flex:0 0 auto;height:37px;font-size:10px}}
      .tour-spotlight{position:fixed;z-index:90;border:3px solid #35df8b;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,22,12,.72),0 0 0 7px rgba(53,223,139,.18);pointer-events:none;transition:top .22s,left .22s,width .22s,height .22s}.tour-popover{position:fixed;z-index:91;width:min(360px,calc(100vw - 24px));padding:17px;border:1px solid #cce8da;border-radius:15px;background:#fff;color:#172b3f;box-shadow:0 18px 55px rgba(0,35,19,.28)}.tour-popover small{display:block;margin-bottom:5px;color:#087747;font-size:12px;font-weight:600}.tour-popover h3{margin:0 0 7px;font-size:18px}.tour-popover p{margin:0;color:#60758a;font-size:14px;line-height:1.5}.tour-controls{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:15px}.tour-controls div{display:flex;gap:7px}.tour-controls button{min-height:38px;padding:0 12px;border:1px solid #cad8e5;border-radius:9px;background:#fff;color:#173149;font:500 13px inherit;cursor:pointer}.tour-controls .tour-next{border-color:#079854;background:#0aad63;color:#fff}.tour-controls button:focus-visible{outline:3px solid #0aad6340}.tour-skip{color:#687b90!important;border-color:transparent!important;background:transparent!important}
      .global-help-button{position:fixed;z-index:48;right:20px;bottom:20px;min-height:46px;padding:0 16px;display:inline-flex;align-items:center;gap:8px;border:1px solid #087747;border-radius:24px;background:#087747;color:#fff;font-size:13px;font-weight:600;box-shadow:0 10px 28px rgba(2,80,43,.25);cursor:pointer}.global-help-button:hover{background:#06683d;transform:translateY(-1px)}.global-help-button:focus-visible{outline:3px solid #60e5a1;outline-offset:3px}.global-help-button svg{width:19px;height:19px}
      .first-use-backdrop{position:fixed;z-index:80;inset:0;display:grid;place-items:center;padding:18px;background:rgba(1,24,13,.64);backdrop-filter:blur(4px)}.first-use-dialog{width:min(100%,520px);padding:25px;border:1px solid #d7e7df;border-radius:18px;background:#fff;color:#172b3f;box-shadow:0 25px 70px rgba(0,28,15,.3)}.first-use-dialog .tip-icon{width:48px;height:48px;display:grid;place-items:center;margin-bottom:15px;border-radius:14px;background:#e1f7eb;color:#087747;font-size:22px}.first-use-dialog h2{margin:0 0 8px;font-size:23px}.first-use-dialog p{margin:0 0 18px;color:#60758a;font-size:14px;line-height:1.6}.first-use-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:9px}.first-use-actions a,.first-use-actions button{min-height:42px;padding:0 14px;border:1px solid #cad8e5;border-radius:10px;background:#fff;color:#173149;font:500 14px inherit;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}.first-use-actions .primary{border-color:#079854;background:#0aad63;color:#fff}
      @media(max-width:560px){.global-help-button{right:12px;bottom:12px;width:46px;padding:0;justify-content:center}.global-help-button span{display:none}.first-use-dialog{padding:19px}.first-use-actions{display:grid}.first-use-actions>*{width:100%;justify-content:center}}
      /* Responsividade global: notebooks, tablets e celulares */
      body.workspace-operational{overflow-x:hidden}
      body.workspace-operational img,body.workspace-operational video,body.workspace-operational canvas,body.workspace-operational svg{max-width:100%}
      body.workspace-operational .table-scroll,body.workspace-operational .table-wrap,body.workspace-operational .audit-scroll,body.workspace-operational .inventory-items{-webkit-overflow-scrolling:touch;scrollbar-width:thin}
      body.workspace-operational table{min-width:720px}
      body.workspace-operational .header-actions,body.workspace-operational .header-right{display:flex;flex-wrap:wrap;align-items:center}
      @media(max-width:1180px){
        body.workspace-page-stock .dashboard-grid{grid-template-columns:minmax(0,1fr) minmax(280px,.8fr)!important}
        body.workspace-page-stock .dashboard-grid>*:last-child{grid-column:1/-1}
        body.workspace-page-stock .kpis{grid-template-columns:repeat(3,minmax(0,1fr))!important}
        body.workspace-page-toner .kpis{grid-template-columns:repeat(3,minmax(0,1fr))!important}
      }
      @media(max-width:820px){
        body.workspace-operational .header-inner{width:calc(100% - 28px)!important;padding:14px 0!important}
        body.workspace-operational .content,body.workspace-page-toner .page{width:100%!important;padding-left:14px!important;padding-right:14px!important}
        body.workspace-page-stock .dashboard-grid{grid-template-columns:1fr!important}
        body.workspace-page-stock .dashboard-grid>*{grid-column:auto!important}
        body.workspace-page-stock .kpis,body.workspace-page-toner .kpis{grid-template-columns:repeat(2,minmax(0,1fr))!important}
        body.workspace-page-central .grid{grid-template-columns:1fr!important}
        body.workspace-page-central .kpis{grid-template-columns:repeat(2,minmax(0,1fr))!important}
        body.workspace-page-central .pending{grid-template-columns:12px minmax(0,1fr) auto!important}
        body.workspace-page-central .pending .owner,body.workspace-page-central .pending .date{display:none}
        body.workspace-page-colaboradores .stats{grid-template-columns:repeat(2,minmax(0,1fr))!important}
        body.workspace-page-colaboradores .filters{grid-template-columns:1fr!important}
      }
      @media(max-width:560px){
        body.workspace-operational .brand h1,body.workspace-page-colaboradores .brand h1{font-size:15px!important}
        body.workspace-operational .brand p,body.workspace-page-colaboradores .brand p{font-size:9px!important}
        body.workspace-operational .header-actions,body.workspace-operational .header-right{width:100%;display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px!important}
        body.workspace-operational .header-actions>.btn,body.workspace-operational .header-right>.btn,body.workspace-operational .header-right>.back-link,body.workspace-operational .auth-account{width:100%;justify-content:center;min-width:0}
        body.workspace-operational .workspace-tabs{scroll-snap-type:x proximity}
        body.workspace-operational .workspace-tab{scroll-snap-align:start}
        body.workspace-page-stock .kpis,body.workspace-page-toner .kpis,body.workspace-page-central .kpis,body.workspace-page-colaboradores .stats{grid-template-columns:1fr!important}
        body.workspace-page-stock .toolbar,body.workspace-page-central .filters{display:grid!important;grid-template-columns:1fr!important}
        body.workspace-page-stock .toolbar>*,body.workspace-page-central .filters>*{width:100%!important}
        body.workspace-page-toner .history-summary{grid-template-columns:1fr 1fr!important}
        body.workspace-page-central .actions{display:grid!important;grid-template-columns:1fr 1fr}
        body.workspace-page-central .actions .btn{width:100%}
        body.workspace-page-central .form{grid-template-columns:1fr!important}
        body.workspace-page-central .form>*{grid-column:1!important}
        body.workspace-page-colaboradores .wrap>header{padding:14px!important}
        body.workspace-operational button,body.workspace-operational .btn,body.workspace-operational input,body.workspace-operational select{min-height:42px}
      }
    `;
    document.head.appendChild(style);
  }

  function accountControl(user) {
    const element = document.createElement("a");
    element.className = "auth-account";
    element.href = "/profile.html";
    element.title = "Minha conta · " + (ROLE_LABELS[user.role] || user.role);
    element.innerHTML = '<span class="auth-avatar">' + String(user.username || "U").slice(0, 2).toUpperCase()
      + '</span><span class="auth-copy"><strong></strong><span></span></span>';
    element.querySelector("strong").textContent = user.username;
    element.querySelector(".auth-copy span").textContent = ROLE_LABELS[user.role] || user.role;
    return element;
  }

  function utilityIcon(type) {
    if (type === "users") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>';
    if (type === "settings") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09A1.7 1.7 0 0 0 8.97 19.35a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.09A1.7 1.7 0 0 0 4.65 8.94a1.7 1.7 0 0 0-.34-1.88L4.25 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10.05 3H14v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg>';
    if (type === "logout") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></svg>';
    return "";
  }

  function link(label, href, type) {
    const element = document.createElement("a");
    element.className = "btn btn-header back-link auth-link" + (type ? " workspace-utility-link" : "");
    element.href = href;
    element.innerHTML = utilityIcon(type) + "<span></span>";
    element.querySelector("span").textContent = label;
    return element;
  }

  function workspaceIcon(type) {
    if (type === "central") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M14 17h7M17.5 13.5v7"/></svg>';
    if (type === "activity") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M4 7h10l-2-2m2 2-2 2"/><path d="M4 13h15l-2-2m2 2-2 2"/><circle cx="4" cy="19" r="2"/></svg>';
    if (type === "stock") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-9 5 9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>';
    if (type === "toner") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>';
    if (type === "identifier") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 13 13 20l-9-9V4h7l9 9Z"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>';
  }

  function installSmoothNavigation() {
    const TRANSITION_KEY = "nxt-workspace-transition";
    let transitioning = false;
    const style = document.createElement("style");
    style.textContent = `
      body.workspace-navigation-leaving main,
      body.workspace-navigation-leaving .content,
      body.workspace-navigation-leaving .wrap > #app {
        opacity: .72;
        transform: translateY(-2px);
        transition: opacity 85ms ease-out,transform 85ms ease-out;
        pointer-events: none;
      }
      body.workspace-navigation-arriving main,
      body.workspace-navigation-arriving .content,
      body.workspace-navigation-arriving .wrap > #app {
        animation: workspace-quick-enter 155ms cubic-bezier(.22,.8,.24,1) both;
      }
      .workspace-tab.transition-target {
        border-color:rgba(92,244,161,.58)!important;
        background:rgba(27,214,112,.2)!important;
        transition:background 80ms ease,border-color 80ms ease!important;
      }
      @keyframes workspace-quick-enter {
        from { opacity:.76; transform:translateY(3px); }
        to { opacity:1; transform:translateY(0); }
      }
      @media(prefers-reduced-motion:reduce) {
        body.workspace-navigation-leaving main,
        body.workspace-navigation-leaving .content,
        body.workspace-navigation-leaving .wrap > #app,
        body.workspace-navigation-arriving main,
        body.workspace-navigation-arriving .content,
        body.workspace-navigation-arriving .wrap > #app {
          animation:none!important;
          transition:none!important;
          transform:none!important;
        }
      }
    `;
    document.head.appendChild(style);

    function hasPendingTransition() {
      try {
        const value = JSON.parse(sessionStorage.getItem(TRANSITION_KEY) || "null");
        if (!value || Date.now() - Number(value.startedAt || 0) > 10000) {
          sessionStorage.removeItem(TRANSITION_KEY);
          return false;
        }
        return true;
      } catch {
        return false;
      }
    }

    if (hasPendingTransition()) document.body.classList.add("workspace-navigation-arriving");

    window.NXT_FINISH_WORKSPACE_TRANSITION = function () {
      try { sessionStorage.removeItem(TRANSITION_KEY); } catch {}
      window.setTimeout(function () {
        document.body.classList.remove("workspace-navigation-arriving", "workspace-navigation-leaving");
        document.documentElement.removeAttribute("aria-busy");
      }, 170);
    };

    document.addEventListener("click", function (event) {
      const anchor = event.target.closest("a.workspace-tab");
      if (!anchor || transitioning || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.origin !== window.location.origin || (target.pathname === window.location.pathname && target.search === window.location.search)) return;
      event.preventDefault();
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        window.location.href = target.href;
        return;
      }
      transitioning = true;
      anchor.classList.add("transition-target");
      document.body.classList.add("workspace-navigation-leaving");
      document.documentElement.setAttribute("aria-busy", "true");
      try { sessionStorage.setItem(TRANSITION_KEY, JSON.stringify({ startedAt: Date.now() })); } catch {}
      window.setTimeout(function () { window.location.href = target.href; }, 85);
    });
  }

  function installWorkspaceNavigation(cachedUser) {
    const path = window.location.pathname;
    if (!WORKSPACE_PAGES.includes(path)) return;
    document.body.classList.add("workspace-operational");
    if (path === "/central.html" || path === "/inteligencia.html") document.body.classList.add("workspace-page-central");
    if (path === "/atividades.html") document.body.classList.add("workspace-page-activities");
    if (path === "/" || path === "/index.html" || path === "/identificadores.html") document.body.classList.add("workspace-page-stock");
    if (path === "/toner.html" || path === "/toner-operacao.html") document.body.classList.add("workspace-page-toner");
    if (path === "/colaboradores.html") document.body.classList.add("workspace-page-colaboradores");

    document.querySelectorAll('a[href="/central.html"],a[href="/"],a[href="/index.html"],a[href="/toner.html"],a[href="/colaboradores.html"]').forEach(function (anchor) {
      if (anchor.closest(".header-actions, .header-right")) anchor.dataset.oldWorkspaceLink = "true";
    });

    const shell = document.createElement("div");
    shell.className = "workspace-tabs-shell " + (cachedUser ? "access-ready" : "access-loading");
    const nav = document.createElement("nav");
    nav.className = "workspace-tabs";
    nav.setAttribute("aria-label", "Módulos do sistema");
    [
      { href: "/central.html", type: "central", title: "Início", subtitle: "Resumo e pendências", paths: ["/central.html"] },
      { href: "/inteligencia.html", type: "activity", title: "Alertas", subtitle: "Saúde da operação", paths: ["/inteligencia.html"] },
      { href: "/atividades.html", type: "activity", title: "Histórico", subtitle: "Ações realizadas", paths: ["/atividades.html"], permission: "view_audit" },
      { href: "/", type: "stock", title: "Ativos", subtitle: "Estoque e solicitações", paths: ["/", "/index.html"], permission: "stock" },
      { href: "/identificadores.html", type: "identifier", title: "Etiquetas", subtitle: "Seriais e impressão", paths: ["/identificadores.html"], permission: "stock" },
      { href: "/toner.html?v=20260828-9", type: "toner", title: "Toners", subtitle: "Impressoras e suprimentos", paths: ["/toner.html", "/toner-operacao.html"], permission: "toner" },
      { href: "/colaboradores.html", type: "people", title: "Colaboradores", subtitle: "Acessos e movimentações", paths: ["/colaboradores.html"], permission: "collaborators" }
    ].forEach(function (item) {
      if (cachedUser && item.permission && (cachedUser.permissions || {})[item.permission] === false) return;
      const anchor = document.createElement("a");
      anchor.className = "workspace-tab" + (item.paths.includes(path) ? " active" : "");
      anchor.href = item.href;
      if (item.paths.includes(path)) anchor.setAttribute("aria-current", "page");
      anchor.innerHTML = workspaceIcon(item.type) + '<span class="workspace-tab-copy"><span>'
        + item.title + "</span><small>" + item.subtitle + "</small></span>";
      nav.appendChild(anchor);
    });
    shell.appendChild(nav);
    if (!cachedUser) {
      const loader = document.createElement("div");
      loader.className = "workspace-tabs-loader";
      loader.setAttribute("aria-label", "Carregando módulos autorizados");
      loader.innerHTML = "<span></span><span></span><span></span>";
      shell.appendChild(loader);
    }

    const header = path === "/colaboradores.html"
      ? document.querySelector(".wrap > header")
      : document.querySelector(".header");
    if (header) header.insertAdjacentElement("afterend", shell);

    if (path === "/" || path === "/index.html") {
      const content = document.querySelector(".content");
      if (content) {
        const heading = document.createElement("section");
        heading.className = "workspace-page-heading";
        heading.innerHTML = '<div><span>Operação de ativos</span><h2>Visão geral do estoque</h2></div>'
          + '<p>Acompanhe disponibilidade, níveis mínimos e solicitações de reposição em uma única tela.</p>';
        content.insertBefore(heading, content.firstChild);
      }
    }
  }

  function installHelpExperience() {
    if (["/login.html", "/setup.html", "/ajuda.html"].includes(window.location.pathname)) return;
    const button = document.createElement("button");
    button.type = "button"; button.className = "global-help-button";
    button.setAttribute("aria-label", "Preciso de ajuda");
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.4 1.8c-1.3 1-2.5 1.7-2.5 3.2M12 18h.01"/></svg><span>Preciso de ajuda</span>';
    button.addEventListener("click", function () { window.location.href = "/ajuda.html?origem=" + encodeURIComponent(window.location.pathname); });
    document.body.appendChild(button);

    fetch("/api/auth/training-progress", { cache:"no-store" }).then(function (response) {
      if (!response.ok) return null; return response.json();
    }).then(function (data) {
      if (!data || (data.progress && data.progress["welcome-seen"])) return;
      const backdrop = document.createElement("div"); backdrop.className = "first-use-backdrop"; backdrop.setAttribute("role", "presentation");
      const dialog = document.createElement("section"); dialog.className = "first-use-dialog"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-labelledby", "firstUseTitle");
      dialog.innerHTML = '<div class="tip-icon" aria-hidden="true">?</div><h2 id="firstUseTitle">Bem-vindo ao Nexo TI</h2><p>A Central de Ajuda reúne um tutorial inicial e guias rápidos de cada módulo. Seu progresso fica salvo no seu usuário.</p><div class="first-use-actions"><button type="button">Ver depois</button><a class="primary" href="/ajuda.html">Começar tutorial</a></div>';
      function seen() { fetch("/api/auth/training-progress/welcome-seen", { method:"PUT", headers:{"content-type":"application/json"}, body:JSON.stringify({completed:true}) }).catch(function () {}); }
      dialog.querySelector("button").addEventListener("click", function () { seen(); backdrop.remove(); });
      dialog.querySelector("a").addEventListener("click", function () { backdrop.remove(); });
      backdrop.appendChild(dialog); document.body.appendChild(backdrop); dialog.querySelector("a").focus();
    }).catch(function () {});
  }

  const GUIDED_TOURS = {
    "getting-started": [
      { selector:".workspace-tabs", title:"Navegação principal", text:"Use estas guias para alternar entre Visão geral, Atividades, Estoque, Identificadores, Toners e Colaboradores." },
      { selector:".kpis,.stats", title:"Resumo do dia", text:"Os indicadores mostram rapidamente o que precisa de atenção." },
      { selector:".pending-list,.pending,.grid", title:"Próximas ações", text:"Aqui ficam as pendências e atividades que devem ser conferidas." }
    ],
    stock: [
      { selector:"#search,.toolbar input[type='search'],input[type='search']", title:"Pesquisar no estoque", text:"Digite o patrimônio, nome, modelo ou categoria para encontrar um ativo." },
      { selector:".kpis", title:"Indicadores do estoque", text:"Confira saldo, categorias abaixo do mínimo e itens a solicitar." },
      { selector:".toolbar,section.filters", title:"Filtros e ações", text:"Use os filtros para reduzir a lista e os botões para atualizar ou exportar." }
    ],
    toner: [
      { selector:"#search,.toolbar input", title:"Pesquisar impressora", text:"Pesquise por IP, modelo, local ou nome do suprimento." },
      { selector:".kpis", title:"Situação da frota", text:"Veja quantas impressoras estão online, em atenção ou precisam de toner." },
      { selector:".cards,.printer-grid,.grid", title:"Detalhes da impressora", text:"Abra o card para conferir níveis, contadores e histórico de trocas." }
    ],
    collaborators: [
      { selector:"#dropzone", title:"Atualizar colaboradores", text:"Arraste a planilha ou clique nesta área para selecionar o arquivo atualizado." },
      { selector:".filters,input[type='search']", title:"Pesquisar colaborador", text:"Use a pesquisa e os filtros para localizar férias, retornos, transferências e desligamentos." },
      { selector:"#app,.table-wrap", title:"Ações de acesso", text:"Confira os acessos envolvidos e registre a conclusão de cada atividade." }
    ],
    activities: [
      { selector:".filters,input[type='search']", title:"Pesquisar atividades", text:"Busque por ativo, descrição, usuário ou módulo." },
      { selector:".kpis,.stats", title:"Resumo do período", text:"Estes números resumem as atividades encontradas nos filtros atuais." },
      { selector:".pagination,.pager,[class*='pagin']", title:"Navegar entre páginas", text:"Avance pelas páginas para consultar o histórico sem criar uma lista muito longa." }
    ],
    reports: [
      { selector:"select", title:"Escolher relatório", text:"Selecione Estoque, Movimentações, Toners, Impressões ou outro relatório disponível." },
      { selector:"input[type='date']", title:"Definir período", text:"Informe as datas inicial e final para consultar somente o período necessário." },
      { selector:"button[type='submit'],.btn-primary", title:"Gerar e exportar", text:"Gere o relatório, revise os resultados e então escolha PDF ou Excel." }
    ],
    automations: [
      { selector:"#cards", title:"Executar automações", text:"Cada card representa uma rotina. Use Executar agora quando precisar antecipar uma atualização." },
      { selector:"#historyTabs", title:"Filtrar o histórico", text:"Alterne entre as guias para visualizar uma sequência menor de execuções." },
      { selector:"#history", title:"Histórico de execuções", text:"Confira duração, resultado e mensagem de erro de cada execução." }
    ],
    "central-tasks": [
      { selector:"#taskForm", title:"Criar uma tarefa", text:"Preencha título, responsável, prazo e categoria da atividade." },
      { selector:"#taskTitle", title:"Descrever a atividade", text:"Use um título curto que deixe clara a ação necessária." },
      { selector:"#tasks", title:"Acompanhar tarefas", text:"As tarefas registradas aparecem aqui até serem concluídas." }
    ],
    "stock-search": [
      { selector:"#searchInput", title:"Pesquisar um ativo", text:"Digite patrimônio, nome, modelo, colaborador ou categoria." },
      { selector:"#filterCompany", title:"Filtrar por empresa", text:"Combine a pesquisa com empresa, tipo, fabricante e status." },
      { selector:"#tableBody", title:"Abrir os detalhes", text:"Selecione um resultado para consultar todos os dados do ativo." }
    ],
    "stock-export": [
      { selector:"#exportButton", title:"Exportar os resultados", text:"Este botão exporta somente os itens correspondentes aos filtros aplicados." },
      { selector:"#resultCount", title:"Conferir a quantidade", text:"Valide quantos registros serão exportados antes de baixar o arquivo." }
    ],
    "toner-add": [
      { selector:"#tonerInventoryToggle", title:"Abrir estoque de toners", text:"Expanda esta seção para cadastrar os cartuchos disponíveis." },
      { selector:"#tonerInventoryModel", open:"#tonerInventoryToggle", title:"Informar o modelo", text:"Digite o código exato do toner, como W9008MC ou CF289X." },
      { selector:"#tonerInventoryColor", title:"Selecionar a cor", text:"Escolha a cor correspondente ao suprimento." },
      { selector:"#tonerInventoryQuantity", title:"Informar a quantidade", text:"Digite quantas unidades estão entrando no estoque." },
      { selector:"#tonerInventoryForm button[type='submit']", title:"Adicionar ao estoque", text:"Confirme para registrar o toner. Depois confira a lista e o saldo atualizado." }
    ],
    "toner-printer-add": [
      { selector:"#managePrintersButton", title:"Gerenciar impressoras", text:"Abra o cadastro de IPs monitorados pelo sistema." },
      { selector:"#printerIp", open:"#managePrintersButton", title:"Informar o IP", text:"Digite o endereço IP fixo da impressora." },
      { selector:"#printerModel", title:"Informar o modelo", text:"Cadastre o modelo completo para facilitar a identificação." },
      { selector:"#printerLocation", title:"Informar o local", text:"Use um nome conhecido pela equipe, como setor ou sala." },
      { selector:"#printerSave", title:"Adicionar a impressora", text:"Salve e execute Atualizar impressoras para realizar a primeira leitura SNMP." }
    ],
    "toner-search": [
      { selector:"#search", title:"Pesquisar impressora", text:"Digite IP, modelo, setor ou nome do toner." },
      { selector:"#status", title:"Filtrar por situação", text:"Visualize somente impressoras críticas, em atenção, online ou offline." },
      { selector:"#printerGrid", title:"Conferir os suprimentos", text:"Cada card mostra os níveis, o estado da impressora e os contadores disponíveis." }
    ],
    "toner-exchange": [
      { selector:"a[href*='toner-operacao']", title:"Abrir Registrar troca", text:"Entre na área operacional para visualizar as substituições recomendadas." },
      { selector:"#worklist", title:"Roteiro de trocas", text:"A lista organiza impressoras e suprimentos que precisam de atendimento." },
      { selector:"#reload", title:"Atualizar a lista", text:"Atualize depois de uma nova leitura para validar níveis e trocas automáticas." }
    ],"collaborators-import": [
      { selector:"#dropzone", title:"Importar colaboradores", text:"Arraste a planilha atualizada ou clique para selecionar o arquivo." },
      { selector:"#fileMeta", title:"Conferir a importação", text:"Verifique o nome do arquivo, a quantidade de registros e a data de atualização." },
      { selector:"#cards", title:"Revisar os indicadores", text:"Depois da importação, confira desligamentos, transferências, férias e afastamentos." }
    ],
    "collaborators-vacation": [
      { selector:"#countFerias", title:"Abrir Férias e acessos", text:"Selecione o indicador para visualizar colaboradores em férias ou próximos do período." },
      { selector:"#searchFerias", title:"Pesquisar colaborador", text:"Localize rapidamente a pessoa pelo nome, matrícula ou setor." },
      { selector:"#tbodyFerias", title:"Configurar acessos", text:"Abra o colaborador para definir responsáveis, prazos e acessos a suspender ou reativar." }
    ],
    "activities-search": [
      { selector:"#search", title:"Pesquisar no histórico", text:"Digite atividade, ativo, descrição ou informação relacionada." },
      { selector:"#from", title:"Definir o período", text:"Use as datas inicial e final para reduzir os resultados." },
      { selector:"#user", title:"Filtrar responsável", text:"Selecione um usuário e, se necessário, combine com o filtro de módulo." },
      { selector:"#pagination", title:"Navegar pelo histórico", text:"Use a paginação para acompanhar a sequência sem ocupar toda a página." }
    ],
    "reports-generate": [
      { selector:"#type", title:"Escolher o relatório", text:"Selecione o conjunto de dados que deseja analisar." },
      { selector:"#from", title:"Definir a data inicial", text:"Informe o primeiro dia do período." },
      { selector:"#to", title:"Definir a data final", text:"Informe o último dia e use a pesquisa se precisar refinar." },
      { selector:"#generate", title:"Gerar relatório", text:"Clique para atualizar os resultados com os filtros escolhidos." },
      { selector:"#excel", title:"Exportar", text:"Após revisar o resultado, salve em Excel ou PDF." }
    ],
    "automations-daily": [
      { selector:"#dailyEnabled", title:"Ativar os relatórios diários", text:"Habilite o envio automático nos dias úteis." },
      { selector:"#startTime", title:"Horário de abertura", text:"Defina quando o resumo de início das atividades será enviado." },
      { selector:"#closingTime", title:"Horário de fechamento", text:"Defina o horário do relatório de encerramento do dia." },
      { selector:"#saveDaily", title:"Salvar os horários", text:"Confirme os dois horários para aplicar a programação." }
    ],
    "automations-history": [
      { selector:"#historyTabs", title:"Guias do histórico", text:"Filtre as execuções por tipo para manter a lista organizada." },
      { selector:"#history", title:"Resultado da execução", text:"Confira início, duração, resultado e mensagem técnica." },
      { selector:"#historyFooter", title:"Paginação", text:"Avance ou retorne entre as páginas do histórico." }
    ]
  };

  const TOUR_PATHS = {
    "getting-started":"Menu principal → Visão geral",
    "central-tasks":"Menu principal → Visão geral → Tarefas operacionais",
    stock:"Menu principal → Estoque",
    "stock-search":"Menu principal → Estoque → Pesquisa e filtros",
    "stock-export":"Menu principal → Estoque → Pesquisa e filtros → Exportar",
    toner:"Menu principal → Toners",
    "toner-add":"Menu principal → Toners → Estoque de toners → Expandir",
    "toner-printer-add":"Menu principal → Toners → Gerenciar IPs",
    "toner-search":"Menu principal → Toners → Pesquisa de impressoras",
    "toner-exchange":"Menu principal → Toners → Registrar troca → Roteiro de trocas",
    collaborators:"Menu principal → Colaboradores",
    "collaborators-import":"Menu principal → Colaboradores → Importar planilha",
    "collaborators-vacation":"Menu principal → Colaboradores → Férias e acessos",
    activities:"Menu principal → Atividades",
    "activities-search":"Menu principal → Atividades → Filtros do histórico",
    reports:"Configurações → Criar ou consultar relatórios",
    "reports-generate":"Configurações → Criar ou consultar relatórios → Gerar relatório",
    automations:"Configurações → Monitorar automações",
    "automations-daily":"Configurações → Configurar horários → Relatório diário",
    "automations-history":"Configurações → Monitorar automações → Histórico de execuções"
  };

  function startGuidedTour(key) {
    const originalSteps = GUIDED_TOURS[key] || [];
    const steps = originalSteps.slice();
    if (TOUR_PATHS[key]) steps.unshift({
      selector:".workspace-tabs,.header-actions,.header-right,.header",
      title:"Como chegar até esta função",
      text:TOUR_PATHS[key]
    }); let current = 0, spotlight, popover, target;
    function remove() { if (spotlight) spotlight.remove(); if (popover) popover.remove(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); const url=new URL(location.href);url.searchParams.delete("tour");history.replaceState(null,"",url.pathname+url.search+url.hash); }
    function position() {
      if (!target || !spotlight || !popover) return; const rect=target.getBoundingClientRect(),pad=6;
      spotlight.style.left=Math.max(4,rect.left-pad)+"px";spotlight.style.top=Math.max(4,rect.top-pad)+"px";spotlight.style.width=Math.min(innerWidth-8,rect.width+pad*2)+"px";spotlight.style.height=Math.min(innerHeight-8,rect.height+pad*2)+"px";
      const below=rect.bottom+14, top=below+popover.offsetHeight<innerHeight?below:Math.max(12,rect.top-popover.offsetHeight-14);
      popover.style.top=top+"px";popover.style.left=Math.min(innerWidth-popover.offsetWidth-12,Math.max(12,rect.left))+"px";
    }
    function finish() { const progressKey=key==="getting-started"?"getting-started":key.startsWith("central-")?"getting-started":key.split("-")[0]; fetch("/api/auth/training-progress/"+encodeURIComponent(progressKey),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({completed:true})}).catch(function(){}); remove(); }
    function show() {
      while(current<steps.length && !(target=document.querySelector(steps[current].selector))) current++;
      if(current>=steps.length){finish();return;}
      const pendingStep=steps[current];
      if(pendingStep.open && target.getClientRects().length===0){const opener=document.querySelector(pendingStep.open);if(opener)opener.click();setTimeout(show,220);return;}
      target.scrollIntoView({behavior:"smooth",block:"center"});
      if(!spotlight){spotlight=document.createElement("div");spotlight.className="tour-spotlight";popover=document.createElement("section");popover.className="tour-popover";popover.setAttribute("role","dialog");popover.setAttribute("aria-live","polite");document.body.append(spotlight,popover);window.addEventListener("resize",position);window.addEventListener("scroll",position,true);}
      const step=steps[current];popover.textContent="";const meta=document.createElement("small");meta.textContent="Etapa "+(current+1)+" de "+steps.length;const title=document.createElement("h3");title.textContent=step.title;const text=document.createElement("p");text.textContent=step.text;
      const controls=document.createElement("div");controls.className="tour-controls";const skip=document.createElement("button");skip.className="tour-skip";skip.type="button";skip.textContent="Sair";skip.onclick=remove;const group=document.createElement("div");
      if(current>0){const prev=document.createElement("button");prev.type="button";prev.textContent="Voltar";prev.onclick=function(){current--;show()};group.appendChild(prev);}
      const next=document.createElement("button");next.type="button";next.className="tour-next";next.textContent=current===steps.length-1?"Concluir":"Próximo";next.onclick=function(){if(current===steps.length-1)finish();else{current++;show();}};group.appendChild(next);controls.append(skip,group);popover.append(meta,title,text,controls);setTimeout(position,260);next.focus();
    }
    if(!steps.length)return; show();
  }
  window.NXT_START_TOUR = startGuidedTour;

  function decorate(user) {
    const permissions=user.permissions||{};
    [{path:"/",key:"stock"},{path:"/identificadores.html",key:"stock"},{path:"/toner.html",key:"toner"},{path:"/colaboradores.html",key:"collaborators"},{path:"/atividades.html",key:"view_audit"}].forEach(function(item){
      document.querySelectorAll('.workspace-tab[href^="'+item.path+'"]').forEach(function(tab){if(permissions[item.key]===false)tab.remove();});
    });
    const current=window.location.pathname,currentKey=(current==="/toner.html"||current==="/toner-operacao.html")?"toner":current==="/colaboradores.html"?"collaborators":current==="/atividades.html"?"view_audit":(current==="/"||current==="/index.html"||current==="/identificadores.html")?"stock":"";
    if(currentKey&&permissions[currentKey]===false)window.location.replace("/central.html");
    const actions = document.querySelector(".header-actions, .header-right");
    if (actions) {
      if (user.canManageUsers) { actions.appendChild(link("Usuários", "/admin.html", "users")); if (window.location.pathname !== "/configuracoes.html") actions.appendChild(link("Configurações", "/configuracoes.html", "settings")); }
      actions.appendChild(accountControl(user));
      const logout = link("Sair", "#", "logout");
      logout.addEventListener("click", async function (event) {
        event.preventDefault();
        await fetch("/api/auth/logout", { method: "POST" });
        try { sessionStorage.removeItem(WORKSPACE_USER_CACHE); } catch {}
        window.location.replace("/login.html");
      });
      actions.appendChild(logout);
    }
    const shell = document.querySelector(".workspace-tabs-shell");
    if (shell) {
      shell.querySelector(".workspace-tabs-loader")?.remove();
      shell.classList.remove("access-loading");
      shell.classList.add("access-ready");
    }
    document.body.classList.add("role-" + user.role);
    ["nxtUpdateButton","uploadButton","tonerThresholdButton","refreshButton"].forEach(function(id){
      const element=document.getElementById(id);
      if(element)element.hidden=user.role!=="master";
    });
  }

  /*
   * O shell visual precisa existir antes da consulta ao usuário para evitar
   * que o navegador mostre por um instante o layout antigo de cada módulo.
   */
  const initialWorkspaceUser = cachedWorkspaceUser();
  addStyles();
  installSmoothNavigation();
  installWorkspaceNavigation(initialWorkspaceUser);
  document.documentElement.classList.add("workspace-ready");

  window.NXT_AUTH_PROMISE = requestUser().then(function (user) {
    window.NXT_CURRENT_USER = user;
    decorate(user);
    if (window.NXT_FINISH_WORKSPACE_TRANSITION) {
      window.setTimeout(window.NXT_FINISH_WORKSPACE_TRANSITION, 110);
    }
    installHelpExperience();
    const requestedTour = new URLSearchParams(window.location.search).get("tour");
    if (requestedTour) setTimeout(function () { startGuidedTour(requestedTour); }, 350);
    return user;
  });
})();
