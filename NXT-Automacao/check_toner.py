#!/usr/bin/env python3
"""
Verificador de Toner via SNMP (100% Python, sem dependencias externas)
========================================================================
Consulta as impressoras ativas do portal via SNMP (Printer-MIB, RFC 3805) e
reporta o nivel de toner de cada uma, sinalizando quais estao baixas e
sugerindo modelo/quantidade de cartucho a comprar.

REQUISITOS: apenas Python 3 instalado (nada de instalar programas extras,
funciona nativamente no Windows, Linux ou Mac).

USO (abra o Prompt de Comando/PowerShell na pasta do script):
    python check_toner.py
    python check_toner.py --limite 15
    python check_toner.py --csv relatorio.csv
"""

import argparse
import csv
import os
import sqlite3
import sys
from dataclasses import dataclass, field
from collections import defaultdict
from pathlib import Path

from snmp_lite import snmp_get, snmp_walk

# ----------------------------------------------------------------------------
# 1) LISTA DE IMPRESSORAS (IP -> modelo)
# ----------------------------------------------------------------------------
LEGACY_PRINTERS = [
    ("192.168.5.20", "HP LaserJet Pro MFP M428fdw"),
    ("192.168.5.21", "HP LaserJet Pro MFP M428fdw"),
    ("192.168.5.22", "HP LaserJet Pro MFP M428fdw"),
    ("192.168.5.23", "HP LaserJet Pro MFP M428fdw"),
    ("192.168.5.25", "HP LaserJet Pro MFP M428fdw"),
    ("192.168.3.239", "HP Color LaserJet Flow E57540"),
    ("192.168.3.253", "HP LaserJet Flow MFP E52645"),
    ("192.168.3.220", "HP Color LaserJet E55040"),
    ("192.168.3.227", "HP LaserJet Flow MFP E52645"),
    ("192.168.3.221", "HP Color LaserJet E55040"),
    ("192.168.3.228", "HP LaserJet Flow MFP E52645"),
    ("192.168.3.234", "HP LaserJet Flow MFP E52645"),
    ("192.168.3.243", "HP Color LaserJet Pro MFP M479fdw"),
    ("192.168.3.235", "HP Color LaserJet Pro M454dw"),
    ("192.168.3.237", "HP Color LaserJet MFP E57540"),
    ("192.168.3.222", "HP LaserJet Pro MFP M428fdw"),
    ("192.168.3.244", "HP Color LaserJet MFP M479fdw"),
    ("192.168.3.242", "HP LaserJet Pro MFP M428fdw"),
    ("192.168.3.236", "HP LaserJet MFP E42540"),
    ("192.168.3.224", "HP Color LaserJet E55040"),
    ("192.168.3.252", "L1455 Series (Epson - tanque de tinta)"),
    ("192.168.3.238", "Samsung SL-M4070FR"),
    ("192.168.3.254", "HP LaserJet Flow MFP E52645"),
    ("192.168.6.5",   "HP LaserJet Flow MFP E52645"),
    ("192.168.6.4",   "HP LaserJet Pro MFP M428fdw"),
]


def _database_candidates(explicit_path=None):
    """Return likely portal database locations, preserving priority."""
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path).expanduser())

    data_dir = os.environ.get("NXT_DATA_DIR")
    if data_dir:
        candidates.append(Path(data_dir) / "controle-estoque.db")

    script_dir = Path(__file__).resolve().parent
    current_dir = Path.cwd().resolve()
    for base in (script_dir, current_dir, script_dir.parent, current_dir.parent):
        candidates.append(base / "dados" / "controle-estoque.db")
        candidates.append(base / "NXT-Automacao" / "dados" / "controle-estoque.db")

    unique = []
    seen = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        key = str(resolved).lower()
        if key not in seen:
            seen.add(key)
            unique.append(resolved)
    return unique


def load_portal_printers(database_path=None):
    """Load exactly the active printers configured in the local portal."""
    checked = []
    for candidate in _database_candidates(database_path):
        checked.append(str(candidate))
        if not candidate.is_file():
            continue
        try:
            uri = candidate.as_uri() + "?mode=ro"
            with sqlite3.connect(uri, uri=True, timeout=5) as connection:
                rows = connection.execute(
                    "SELECT ip, model FROM printers WHERE active = 1 ORDER BY ip"
                ).fetchall()
            printers = []
            seen_ips = set()
            for ip, model in rows:
                ip = str(ip or "").strip()
                if not ip or ip in seen_ips:
                    continue
                seen_ips.add(ip)
                printers.append((ip, str(model or "Impressora").strip() or "Impressora"))
            return printers, candidate
        except (sqlite3.Error, OSError) as error:
            raise RuntimeError(f"Nao foi possivel ler o banco do portal em {candidate}: {error}") from error

    locations = "\n  - ".join(checked)
    raise FileNotFoundError(
        "Banco do portal nao encontrado. Coloque este arquivo dentro da pasta "
        "NXT-Automacao ou informe --banco. Locais verificados:\n  - " + locations
    )

# ----------------------------------------------------------------------------
# 2) TABELA DE REFERENCIA DE CARTUCHOS (fallback/conferencia).
#    O SNMP normalmente ja devolve a descricao/numero exato do cartucho.
#    Confirme sempre pela etiqueta fisica antes de fechar o pedido.
# ----------------------------------------------------------------------------
CARTRIDGE_REFERENCE = {
    "HP LaserJet Pro MFP M428fdw": [("HP 58A / 58X (CF258A / CF258X)", "Preto")],
    "HP LaserJet Flow MFP E52645": [("HP 89A / 89X / 89Y (CF289A / CF289X / CF289Y)", "Preto")],
    "HP LaserJet MFP E42540": [("HP 87A / 87X (CF287A / CF287X)", "Preto")],
    "HP Color LaserJet Flow E57540": [("HP 658A/X/Y (serie W20xx)", "Preto/Ciano/Magenta/Amarelo")],
    "HP Color LaserJet MFP E57540": [("HP 658A/X/Y (serie W20xx)", "Preto/Ciano/Magenta/Amarelo")],
    "HP Color LaserJet E55040": [("HP 656A/X (serie CF46x)", "Preto/Ciano/Magenta/Amarelo")],
    "HP Color LaserJet Pro MFP M479fdw": [("HP 415A / 415X (serie W203x)", "Preto/Ciano/Magenta/Amarelo")],
    "HP Color LaserJet MFP M479fdw": [("HP 415A / 415X (serie W203x)", "Preto/Ciano/Magenta/Amarelo")],
    "HP Color LaserJet Pro M454dw": [("HP 414A / 414X (serie W142x)", "Preto/Ciano/Magenta/Amarelo")],
    "Samsung SL-M4070FR": [("Samsung MLT-D203 (D203L / D203E / D203U)", "Preto")],
    "L1455 Series (Epson - tanque de tinta)": [("Garrafas de tinta Epson 664/774 (nao e toner)", "Preto/Ciano/Magenta/Amarelo")],
}

DEFAULT_ALERT_THRESHOLD = 20  # %

# OIDs padrao do Printer-MIB (RFC 3805) - funcionam para qualquer marca
OID_SYSNAME = "1.3.6.1.2.1.1.5.0"
OID_SUPPLY_DESC = "1.3.6.1.2.1.43.11.1.1.6.1"
OID_SUPPLY_LEVEL = "1.3.6.1.2.1.43.11.1.1.9.1"
OID_SUPPLY_MAX = "1.3.6.1.2.1.43.11.1.1.8.1"


@dataclass
class Supply:
    description: str
    level: int
    max_capacity: int

    @property
    def percent(self):
        if self.max_capacity in (0, -1, -2) or self.level < 0:
            return None
        return round(100 * self.level / self.max_capacity)


@dataclass
class PrinterResult:
    ip: str
    model: str
    online: bool = False
    hostname: str = ""
    supplies: list = field(default_factory=list)
    error: str = ""


def check_printer(ip: str, model: str, community: str, timeout: float, port: int = 161) -> PrinterResult:
    result = PrinterResult(ip=ip, model=model)

    hostname = snmp_get(ip, OID_SYSNAME, community=community, timeout=timeout, port=port)
    if hostname is None:
        result.online = False
        result.error = "sem resposta SNMP (offline, IP errado, ou SNMP desabilitado/community incorreta)"
        return result

    result.online = True
    result.hostname = str(hostname)

    descriptions = snmp_walk(ip, OID_SUPPLY_DESC, community=community, timeout=timeout, port=port)
    levels = snmp_walk(ip, OID_SUPPLY_LEVEL, community=community, timeout=timeout, port=port)
    maxes = snmp_walk(ip, OID_SUPPLY_MAX, community=community, timeout=timeout, port=port)

    def by_index(rows, base_oid):
        prefix = base_oid.rstrip(".") + "."
        return {
            str(oid)[len(prefix):]: value
            for oid, value in rows
            if str(oid).startswith(prefix)
        }

    descriptions_by_index = by_index(descriptions, OID_SUPPLY_DESC)
    levels_by_index = by_index(levels, OID_SUPPLY_LEVEL)
    maxes_by_index = by_index(maxes, OID_SUPPLY_MAX)

    for index in sorted(set(descriptions_by_index) | set(levels_by_index) | set(maxes_by_index)):
        desc = descriptions_by_index.get(index)
        lvl = levels_by_index.get(index)
        mx = maxes_by_index.get(index)
        if desc is None or lvl is None or mx is None:
            continue
        try:
            result.supplies.append(Supply(description=str(desc), level=int(lvl), max_capacity=int(mx)))
        except (ValueError, TypeError):
            continue

    return result


def suggest_cartridge(model: str):
    return CARTRIDGE_REFERENCE.get(model, [("Nao mapeado - verificar etiqueta do cartucho ou site do fabricante", "?")])


def main():
    parser = argparse.ArgumentParser(description="Verifica niveis de toner via SNMP em toda a rede.")
    parser.add_argument("--limite", type=int, default=DEFAULT_ALERT_THRESHOLD,
                         help=f"Percentual abaixo do qual o toner entra na lista de pedido (padrao: {DEFAULT_ALERT_THRESHOLD}%%)")
    parser.add_argument("--csv", type=str, default=None, help="Caminho para exportar um CSV com o resultado")
    parser.add_argument("--community", type=str, default=os.environ.get("NXT_SNMP_COMMUNITY", ""),
                        help="SNMP community string (ou variavel NXT_SNMP_COMMUNITY)")
    parser.add_argument("--timeout", type=float, default=2.0, help="Timeout por consulta em segundos (padrao: 2.0)")
    parser.add_argument("--porta", type=int, default=161, help="Porta SNMP (padrao: 161)")
    parser.add_argument("--html", type=str, default=None, help="Caminho para gerar um relatorio visual em HTML (ex.: relatorio.html)")
    parser.add_argument("--abrir", action="store_true", help="Abre o relatorio HTML automaticamente no navegador ao terminar")
    parser.add_argument("--banco", type=str, default=None,
                        help="Caminho do banco do portal (dados/controle-estoque.db)")
    parser.add_argument("--lista-fixa", action="store_true",
                        help="Usa a lista antiga gravada no script (somente para contingencia)")
    args = parser.parse_args()
    if not args.community:
        parser.error("Informe --community ou defina NXT_SNMP_COMMUNITY no ambiente.")

    # Se rodou sem nenhum argumento (caso tipico de clique duplo no .exe),
    # assume o modo "so clicar": gera HTML, abre no navegador e tambem salva CSV.
    modo_clique_duplo = len(sys.argv) == 1
    if modo_clique_duplo:
        args.html = args.html or "relatorio_toner.html"
        args.csv = args.csv or "relatorio_toner.csv"
        args.abrir = True

    if args.lista_fixa:
        printers = LEGACY_PRINTERS
        print("ATENCAO: usando a lista fixa antiga por solicitacao.\n")
    else:
        try:
            printers, portal_database = load_portal_printers(args.banco)
        except (FileNotFoundError, RuntimeError) as error:
            print(f"ERRO: {error}")
            print("\nExemplo: python check_toner.py --banco .\\dados\\controle-estoque.db --html relatorio_toner.html --abrir")
            return 2
        print(f"Lista sincronizada com o portal: {portal_database}")

    if not printers:
        print("Nenhuma impressora ativa esta cadastrada no portal.")
        return 0

    print(f"Consultando {len(printers)} impressoras via SNMP...\n")

    all_results = []
    low_toner_orders = []
    offline = []

    for ip, model in printers:
        res = check_printer(ip, model, args.community, args.timeout, args.porta)
        all_results.append(res)

        if not res.online:
            offline.append(res)
            print(f"[{ip:15s}] {model:38s} -> OFFLINE / sem resposta")
            continue

        if not res.supplies:
            print(f"[{ip:15s}] {model:38s} -> respondeu SNMP mas nao retornou dados de suprimentos (verificar MIB/permissao)")
            continue

        for s in res.supplies:
            pct = s.percent
            pct_str = f"{pct}%" if pct is not None else "N/D"
            status = ""
            if pct is not None and pct <= args.limite:
                status = "  <<< PEDIR"
                low_toner_orders.append((ip, model, s.description, pct))
            print(f"[{ip:15s}] {model:38s} | {s.description:30s} {pct_str:>5s}{status}")

    if offline:
        print("\n" + "=" * 90)
        print("IMPRESSORAS SEM RESPOSTA (verifique se estao ligadas, IP certo, ou SNMP habilitado):")
        for r in offline:
            print(f"  - {r.ip:15s} {r.model:38s} -> {r.error}")

    print("\n" + "=" * 90)
    print(f"RESUMO - TONERS ABAIXO DE {args.limite}% (SUGESTAO DE PEDIDO)")
    print("=" * 90)

    if not low_toner_orders:
        print("Nenhum toner abaixo do limite definido. Tudo certo por enquanto!")
    else:
        grouped = defaultdict(list)
        for ip, model, desc, pct in low_toner_orders:
            grouped[(model, desc)].append((ip, pct))

        for (model, desc), occurrences in sorted(grouped.items()):
            qty = len(occurrences)
            ips_str = ", ".join(f"{ip} ({pct}%)" for ip, pct in occurrences)
            cartuchos = suggest_cartridge(model)
            print(f"\n>> {model} - {desc}")
            print(f"   Unidades afetadas ({qty}): {ips_str}")
            for part, color in cartuchos:
                print(f"   Comprar: {qty}x {part}  [{color}]")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["IP", "Modelo", "Consumivel", "Percentual", "Status", "Cartucho sugerido"])
            for res in all_results:
                if not res.online:
                    writer.writerow([res.ip, res.model, "-", "-", "OFFLINE: " + res.error, "-"])
                    continue
                if not res.supplies:
                    writer.writerow([res.ip, res.model, "-", "-", "SEM DADOS DE SUPRIMENTO", "-"])
                    continue
                for s in res.supplies:
                    pct = s.percent
                    status = "PEDIR" if (pct is not None and pct <= args.limite) else "OK"
                    cart = "; ".join(p for p, c in suggest_cartridge(res.model))
                    writer.writerow([res.ip, res.model, s.description, pct if pct is not None else "N/D", status, cart])
        print(f"\nCSV exportado para: {args.csv}")

    if args.html:
        write_html_report(args.html, all_results, args.limite)
        print(f"Relatorio HTML gerado em: {args.html}")
        if args.abrir:
            import webbrowser
            import os
            webbrowser.open("file://" + os.path.abspath(args.html))

    if modo_clique_duplo:
        print("\nConcluido! O relatorio foi aberto no seu navegador.")
        input("\nPressione ENTER para fechar esta janela...")

    return 0


def _color_swatch(description: str) -> str:
    d = description.lower()
    if "cyan" in d or "ciano" in d:
        return "#0891b2"
    if "magenta" in d:
        return "#c2255c"
    if "yellow" in d or "amarel" in d:
        return "#ca8a04"
    if "black" in d or "preto" in d or "k)" in d:
        return "#1f2430"
    return "#6b7280"


def _status_for(pct, limite):
    if pct is None:
        return "unknown", "Sem dado"
    if pct <= limite:
        return "critical", "Pedir agora"
    if pct <= limite + 15:
        return "warning", "Atencao"
    return "ok", "OK"


_ICONS = {
    "critical": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    "warning": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    "ok": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    "offline": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6M12 22v-3M4.93 4.93l3.54 3.54M15.53 15.53l3.54 3.54M2 12h4M18 12h4M4.93 19.07l3.54-3.54M15.53 8.47l3.54-3.54"/><circle cx="12" cy="12" r="3"/></svg>',
    "unknown": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg>',
}

_STATUS_TEXT_PT = {
    "critical": "Pedir agora",
    "warning": "Atencao",
    "ok": "OK",
    "offline": "Offline",
    "unknown": "Sem dado",
}


def write_html_report(path: str, all_results, limite: int):
    total = len(all_results)
    offline_n = sum(1 for r in all_results if not r.online)
    critical_n = 0
    warning_n = 0
    ok_n = 0

    order_key = {"critical": 0, "warning": 1, "unknown": 2, "offline": 3, "ok": 4}
    printer_cards = []
    index = 0

    for r in all_results:
        index += 1
        delay = min(index * 0.035, 0.6)

        if not r.online:
            printer_cards.append(("offline", f"""
        <article class="card card--offline" data-status="offline" data-search="{_esc(r.ip)} {_esc(r.model)}" style="animation-delay:{delay:.3f}s">
          <div class="card__head">
            <div>
              <h3 class="card__model">{_esc(r.model)}</h3>
              <div class="card__ip">{r.ip}</div>
            </div>
            <span class="pill pill--offline">{_ICONS['offline']}<span>Offline</span></span>
          </div>
          <p class="card__empty">{_esc(r.error)}</p>
        </article>"""))
            continue

        if not r.supplies:
            printer_cards.append(("unknown", f"""
        <article class="card card--unknown" data-status="unknown" data-search="{_esc(r.ip)} {_esc(r.model)}" style="animation-delay:{delay:.3f}s">
          <div class="card__head">
            <div>
              <h3 class="card__model">{_esc(r.model)}</h3>
              <div class="card__ip">{r.ip}</div>
            </div>
            <span class="pill pill--unknown">{_ICONS['unknown']}<span>Sem dados</span></span>
          </div>
          <p class="card__empty">Respondeu na rede mas nao retornou niveis de suprimento.</p>
        </article>"""))
            continue

        worst = "ok"
        rows = []
        for s in r.supplies:
            pct = s.percent
            status, label = _status_for(pct, limite)
            if status == "critical":
                critical_n += 1
                worst = "critical"
            elif status == "warning":
                warning_n += 1
                if worst != "critical":
                    worst = "warning"
            elif status == "ok":
                ok_n += 1

            pct_display = pct if pct is not None else 0
            pct_label = f"{pct}%" if pct is not None else "N/D"
            swatch = _color_swatch(s.description)

            rows.append(f"""
            <div class="supply">
              <div class="supply__top">
                <span class="supply__swatch" style="background:{swatch}" aria-hidden="true"></span>
                <span class="supply__desc">{_esc(s.description)}</span>
                <span class="supply__pct supply__pct--{status}">{pct_label}</span>
              </div>
              <div class="gauge" role="img" aria-label="Nivel: {pct_label}, status {label}">
                <div class="gauge__fill gauge__fill--{status}" style="width:{pct_display}%"></div>
                <div class="gauge__tick" style="left:{limite}%"></div>
              </div>
              <div class="supply__label supply__label--{status}">{_ICONS[status]}<span>{label}</span></div>
            </div>""")

        status_label = _STATUS_TEXT_PT[worst]
        printer_cards.append((worst, f"""
        <article class="card card--{worst}" data-status="{worst}" data-search="{_esc(r.ip)} {_esc(r.model)}" style="animation-delay:{delay:.3f}s">
          <div class="card__head">
            <div>
              <h3 class="card__model">{_esc(r.model)}</h3>
              <div class="card__ip">{r.ip}{f" &middot; {_esc(r.hostname)}" if r.hostname else ""}</div>
            </div>
            <span class="pill pill--{worst}">{_ICONS[worst]}<span>{status_label}</span></span>
          </div>
          {"".join(rows)}
        </article>"""))

    printer_cards.sort(key=lambda item: order_key[item[0]])
    cards_html = [html for _, html in printer_cards]

    pct_ok = round(100 * ok_n / total) if total else 0
    generated_at = __import__("datetime").datetime.now().strftime("%d/%m/%Y as %H:%M")

    html = f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Painel de Toner - Frota de Impressoras</title>
<style>
  :root {{
    --bg: #f6f7fb;
    --bg-grad: linear-gradient(180deg, #eef1fb 0%, #f6f7fb 340px);
    --panel: #ffffff;
    --line: #e7e9f0;
    --line-soft: #f0f1f6;
    --text: #101322;
    --muted: #6b7080;
    --muted-2: #9297a8;
    --ok: #059669;
    --ok-bg: #ecfdf5;
    --ok-line: #bbf0d8;
    --warning: #c2760a;
    --warning-bg: #fef8ec;
    --warning-line: #f6dfa8;
    --critical: #e11d48;
    --critical-bg: #fff1f3;
    --critical-line: #fbc7d0;
    --unknown: #6b7280;
    --unknown-bg: #f2f3f6;
    --unknown-line: #e2e4ea;
    --accent: #4f46e5;
    --accent-2: #e11d48;
    --mono: 'SF Mono', 'Consolas', 'SFMono-Regular', Menlo, monospace;
    --sans: -apple-system, 'Segoe UI', system-ui, Roboto, Arial, sans-serif;
    --radius: 14px;
    --radius-sm: 9px;
    --shadow-sm: 0 1px 2px rgba(16,24,40,0.05);
    --shadow-md: 0 2px 8px rgba(16,24,40,0.06), 0 1px 2px rgba(16,24,40,0.04);
    --shadow-lg: 0 8px 24px rgba(16,24,40,0.09);
  }}
  * {{ box-sizing: border-box; }}
  html {{ scroll-behavior: smooth; }}
  body {{
    margin: 0;
    background: var(--bg);
    background-image: var(--bg-grad);
    background-repeat: no-repeat;
    color: var(--text);
    font-family: var(--sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }}

  .topbar {{
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(255,255,255,0.82);
    backdrop-filter: saturate(180%) blur(14px);
    -webkit-backdrop-filter: saturate(180%) blur(14px);
    border-bottom: 1px solid var(--line);
    padding: 20px 36px;
  }}
  .topbar__row {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 18px;
    max-width: 1320px;
    margin: 0 auto;
  }}
  .brand {{
    display: flex;
    align-items: center;
    gap: 12px;
  }}
  .brand__mark {{
    width: 38px;
    height: 38px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    box-shadow: var(--shadow-md);
  }}
  .brand__mark svg {{ width: 20px; height: 20px; color: #fff; }}
  h1 {{
    font-size: 20px;
    margin: 0;
    font-weight: 700;
    letter-spacing: -0.015em;
    line-height: 1.25;
  }}
  .subtitle {{
    color: var(--muted);
    font-size: 12.5px;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }}
  .search-wrap {{
    position: relative;
    flex: 1;
    min-width: 220px;
    max-width: 380px;
  }}
  .search-wrap svg {{
    position: absolute;
    left: 13px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    color: var(--muted-2);
    pointer-events: none;
  }}
  #search {{
    width: 100%;
    padding: 10px 14px 10px 38px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: #fbfbfd;
    font-size: 13.5px;
    color: var(--text);
    transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
  }}
  #search:hover {{ border-color: #d7dae2; }}
  #search:focus {{
    outline: none;
    border-color: var(--accent);
    background: #fff;
    box-shadow: 0 0 0 4px rgba(79,70,229,0.12);
  }}
  .btn-print {{
    border: 1px solid var(--line);
    background: linear-gradient(180deg, #fff, #fafafe);
    color: var(--text);
    padding: 10px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    box-shadow: var(--shadow-sm);
    transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
  }}
  .btn-print:hover {{ box-shadow: var(--shadow-md); transform: translateY(-1px); border-color: #d7dae2; }}
  .btn-print:active {{ transform: translateY(0); }}
  .btn-print svg {{ width: 15px; height: 15px; }}

  main {{
    max-width: 1320px;
    margin: 0 auto;
    padding: 28px 36px 64px;
  }}

  .summary {{
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
    margin-bottom: 26px;
  }}
  .stat {{
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 16px 18px;
    cursor: pointer;
    text-align: left;
    font-family: var(--sans);
    display: flex;
    align-items: center;
    gap: 13px;
    box-shadow: var(--shadow-sm);
    transition: box-shadow 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
  }}
  .stat:hover {{ box-shadow: var(--shadow-lg); transform: translateY(-2px); }}
  .stat.is-active {{ border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79,70,229,0.12), var(--shadow-md); }}
  .stat__icon {{
    width: 36px; height: 36px;
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    flex: none;
  }}
  .stat__icon svg {{ width: 18px; height: 18px; }}
  .stat--critical .stat__icon {{ background: var(--critical-bg); color: var(--critical); }}
  .stat--warning .stat__icon {{ background: var(--warning-bg); color: var(--warning); }}
  .stat--ok .stat__icon {{ background: var(--ok-bg); color: var(--ok); }}
  .stat--offline .stat__icon {{ background: var(--unknown-bg); color: var(--unknown); }}
  .stat--all .stat__icon {{ background: #eef0ff; color: var(--accent); }}
  .stat__num {{ font-size: 25px; font-weight: 800; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }}
  .stat__label {{ font-size: 11.5px; color: var(--muted); margin-top: 3px; font-weight: 500; }}

  .progress-strip {{
    height: 6px;
    border-radius: 100px;
    background: var(--unknown-bg);
    overflow: hidden;
    display: flex;
    margin-bottom: 26px;
    box-shadow: inset 0 0 0 1px var(--line-soft);
  }}
  .progress-strip__seg {{ height: 100%; }}
  .progress-strip__seg--critical {{ background: var(--critical); }}
  .progress-strip__seg--warning {{ background: var(--warning); }}
  .progress-strip__seg--ok {{ background: var(--ok); }}
  .progress-strip__seg--offline {{ background: var(--unknown); }}

  .grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
    gap: 16px;
  }}
  .card {{
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 20px 22px;
    box-shadow: var(--shadow-sm);
    position: relative;
    overflow: hidden;
    animation: rise 0.45s cubic-bezier(.2,.7,.3,1) backwards;
    transition: box-shadow 0.18s ease, transform 0.18s ease;
  }}
  .card:hover {{ box-shadow: var(--shadow-md); transform: translateY(-1px); }}
  .card::before {{
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    background: var(--unknown);
  }}
  .card--ok::before {{ background: var(--ok); }}
  .card--warning::before {{ background: var(--warning); }}
  .card--critical::before {{ background: var(--critical); }}
  .card--offline::before {{ background: var(--unknown); }}
  .card--offline {{ background: #fbfbfd; }}
  .card.is-hidden {{ display: none; }}

  @keyframes rise {{
    from {{ opacity: 0; transform: translateY(8px); }}
    to {{ opacity: 1; transform: translateY(0); }}
  }}

  .card__head {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 6px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--line-soft);
  }}
  .card__model {{
    font-size: 14.5px;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.005em;
  }}
  .card__ip {{
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
    margin-top: 4px;
  }}
  .card__empty {{
    font-size: 12.5px;
    color: var(--muted);
    font-style: italic;
    margin: 10px 0 0;
  }}

  .pill {{
    font-size: 10.5px;
    font-weight: 700;
    padding: 5px 10px;
    border-radius: 100px;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    letter-spacing: 0.01em;
  }}
  .pill svg {{ width: 12px; height: 12px; }}
  .pill--ok {{ background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok-line); }}
  .pill--warning {{ background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning-line); }}
  .pill--critical {{ background: var(--critical-bg); color: var(--critical); border: 1px solid var(--critical-line); }}
  .pill--offline, .pill--unknown {{ background: var(--unknown-bg); color: var(--unknown); border: 1px solid var(--unknown-line); }}

  .supply {{ margin-top: 15px; }}
  .supply:first-of-type {{ margin-top: 14px; }}
  .supply__top {{
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }}
  .supply__swatch {{
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex: none;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08);
  }}
  .supply__desc {{
    font-size: 12.5px;
    flex: 1;
    color: #333947;
    font-weight: 500;
  }}
  .supply__pct {{
    font-family: var(--mono);
    font-size: 12.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }}
  .supply__pct--ok {{ color: var(--ok); }}
  .supply__pct--warning {{ color: var(--warning); }}
  .supply__pct--critical {{ color: var(--critical); }}
  .supply__pct--unknown {{ color: var(--unknown); }}

  .gauge {{
    position: relative;
    height: 9px;
    background: #eef0f4;
    border-radius: 5px;
    overflow: hidden;
    box-shadow: inset 0 1px 2px rgba(16,24,40,0.06);
  }}
  .gauge__fill {{
    height: 100%;
    border-radius: 5px;
    transition: width 0.4s cubic-bezier(.2,.7,.3,1);
    background-image: linear-gradient(rgba(255,255,255,0.25), transparent);
  }}
  .gauge__fill--ok {{ background-color: var(--ok); }}
  .gauge__fill--warning {{ background-color: var(--warning); }}
  .gauge__fill--critical {{ background-color: var(--critical); }}
  .gauge__fill--unknown {{ background-color: var(--unknown); }}
  .gauge__tick {{
    position: absolute;
    top: -1px;
    bottom: -1px;
    width: 2px;
    background: rgba(16,24,40,0.22);
    border-radius: 1px;
  }}
  .supply__label {{
    font-size: 10.5px;
    font-weight: 600;
    margin-top: 5px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    letter-spacing: 0.01em;
  }}
  .supply__label svg {{ width: 11px; height: 11px; }}
  .supply__label--critical {{ color: var(--critical); }}
  .supply__label--warning {{ color: var(--warning); }}

  .empty-state {{
    text-align: center;
    padding: 70px 20px;
    color: var(--muted);
  }}
  .empty-state svg {{ width: 40px; height: 40px; color: var(--muted-2); margin-bottom: 12px; }}
  .empty-state__title {{ font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 4px; }}
  .empty-state__sub {{ font-size: 13px; }}

  footer {{
    margin-top: 44px;
    color: var(--muted-2);
    font-size: 11.5px;
    text-align: center;
    letter-spacing: 0.01em;
  }}

  @media (max-width: 900px) {{
    .summary {{ grid-template-columns: repeat(2, 1fr); }}
  }}
  @media (max-width: 640px) {{
    .topbar, main {{ padding-left: 18px; padding-right: 18px; }}
    .topbar__row {{ flex-direction: column; align-items: stretch; }}
    .search-wrap {{ max-width: none; }}
    .summary {{ grid-template-columns: repeat(2, 1fr); }}
  }}

  @media print {{
    body {{ background: #fff; }}
    .topbar {{ position: static; backdrop-filter: none; background: #fff; }}
    #search, .btn-print {{ display: none; }}
    .card {{ break-inside: avoid; box-shadow: none; }}
    .stat:hover, .card:hover {{ transform: none; }}
  }}
</style>
</head>
<body>
  <div class="topbar">
    <div class="topbar__row">
      <div class="brand">
        <div class="brand__mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        </div>
        <div>
          <h1>Painel de Toner &middot; Frota de Impressoras</h1>
          <div class="subtitle">Gerado em {generated_at} &middot; limite de alerta: {limite}% &middot; {total} impressoras consultadas</div>
        </div>
      </div>
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="search" type="text" placeholder="Buscar por IP ou modelo..." aria-label="Buscar impressora por IP ou modelo">
      </div>
      <button class="btn-print" onclick="window.print()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Imprimir / PDF
      </button>
    </div>
  </div>

  <main>
    <div class="summary" id="filters">
      <button class="stat stat--all is-active" data-filter="all">
        <span class="stat__icon">{_ICONS['unknown']}</span>
        <div><div class="stat__num">{total}</div><div class="stat__label">Total</div></div>
      </button>
      <button class="stat stat--critical" data-filter="critical">
        <span class="stat__icon">{_ICONS['critical']}</span>
        <div><div class="stat__num">{critical_n}</div><div class="stat__label">Pedir agora</div></div>
      </button>
      <button class="stat stat--warning" data-filter="warning">
        <span class="stat__icon">{_ICONS['warning']}</span>
        <div><div class="stat__num">{warning_n}</div><div class="stat__label">Atencao</div></div>
      </button>
      <button class="stat stat--ok" data-filter="ok">
        <span class="stat__icon">{_ICONS['ok']}</span>
        <div><div class="stat__num">{ok_n}</div><div class="stat__label">OK</div></div>
      </button>
      <button class="stat stat--offline" data-filter="offline">
        <span class="stat__icon">{_ICONS['offline']}</span>
        <div><div class="stat__num">{offline_n}</div><div class="stat__label">Offline</div></div>
      </button>
    </div>

    <div class="progress-strip" title="{pct_ok}% da frota esta OK" aria-hidden="true">
      <div class="progress-strip__seg progress-strip__seg--critical" style="width:{100*critical_n/total if total else 0:.2f}%"></div>
      <div class="progress-strip__seg progress-strip__seg--warning" style="width:{100*warning_n/total if total else 0:.2f}%"></div>
      <div class="progress-strip__seg progress-strip__seg--offline" style="width:{100*offline_n/total if total else 0:.2f}%"></div>
      <div class="progress-strip__seg progress-strip__seg--ok" style="width:{100*ok_n/total if total else 0:.2f}%"></div>
    </div>

    <div class="grid" id="grid">
      {"".join(cards_html)}
    </div>
    <div class="empty-state" id="empty-state" style="display:none;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <div class="empty-state__title">Nenhuma impressora encontrada</div>
      <div class="empty-state__sub">Tente ajustar a busca ou escolher outro filtro.</div>
    </div>
  </main>

  <footer>check_toner.py &middot; consulta via SNMP (Printer-MIB RFC 3805) &middot; atualize rodando o script novamente</footer>

<script>
  var currentFilter = 'all';
  var searchInput = document.getElementById('search');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var filterButtons = Array.prototype.slice.call(document.querySelectorAll('.stat'));
  var emptyState = document.getElementById('empty-state');

  function applyFilters() {{
    var term = searchInput.value.trim().toLowerCase();
    var visibleCount = 0;
    cards.forEach(function(card) {{
      var status = card.getAttribute('data-status');
      var search = (card.getAttribute('data-search') || '').toLowerCase();
      var matchesFilter = (currentFilter === 'all') || (status === currentFilter);
      var matchesSearch = term === '' || search.indexOf(term) !== -1;
      var show = matchesFilter && matchesSearch;
      card.classList.toggle('is-hidden', !show);
      if (show) visibleCount++;
    }});
    emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
  }}

  filterButtons.forEach(function(btn) {{
    btn.addEventListener('click', function() {{
      currentFilter = btn.getAttribute('data-filter');
      filterButtons.forEach(function(b) {{ b.classList.remove('is-active'); }});
      btn.classList.add('is-active');
      applyFilters();
    }});
  }});

  searchInput.addEventListener('input', applyFilters);
</script>
</body>
</html>"""

    with open(path, "w", encoding="utf-8") as f:
        f.write(html)

def _esc(text: str) -> str:
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


if __name__ == "__main__":
    main()
