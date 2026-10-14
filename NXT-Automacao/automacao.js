const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const MAX_TENTATIVAS = 7;

async function executarComTentativas(
  nome,
  acao,
  page
) {
  let ultimoErro;

  for (
    let tentativa = 1;
    tentativa <= MAX_TENTATIVAS;
    tentativa++
  ) {
    try {
      console.log(
        `${nome} - tentativa ${tentativa}/${MAX_TENTATIVAS}`
      );

      return await acao(tentativa);
    } catch (error) {
      ultimoErro = error;

      console.warn(
        `${nome} falhou: ${error.message}`
      );

      if (tentativa < MAX_TENTATIVAS) {
        const tempoEspera = Math.min(
          tentativa * 3000,
          15000
        );

        console.log(
          `Nova tentativa em ${tempoEspera / 1000} segundos...`
        );

        await page.waitForTimeout(
          tempoEspera
        );
      }
    }
  }

  throw new Error(
    `${nome} falhou apos ${MAX_TENTATIVAS} tentativas: ${ultimoErro.message}`
  );
}

(async () => {
  const email = process.env.NXT_EMAIL;
  const password = process.env.NXT_PASSWORD;

  if (!email || !password) {
    console.error(
      "Credenciais nao carregadas no PowerShell."
    );

    process.exit(1);
  }

  const dadosDir = process.env.NXT_DATA_DIR
    ? path.resolve(process.env.NXT_DATA_DIR)
    : path.join(__dirname, "dados");

  const erroDir = path.join(dadosDir, "erros");

  const arquivoFinal = path.join(
    dadosDir,
    "estoque-atual.xlsx"
  );

  fs.mkdirSync(dadosDir, {
    recursive: true,
  });

  fs.mkdirSync(erroDir, {
    recursive: true,
  });

  let browser;
  let context;
  let page;

  try {
    console.log(
      "Abrindo o navegador..."
    );

    const executarOculto = process.env.NXT_AUTOMATION_HEADLESS === "1";
    const opcoesNavegador = {
      headless: executarOculto,
    };

    if (process.env.NXT_BROWSER_CHANNEL) {
      opcoesNavegador.channel = process.env.NXT_BROWSER_CHANNEL;
    } else if (process.env.NXT_DESKTOP_MODE === "1") {
      opcoesNavegador.channel = "msedge";
    }

    try {
      browser = await chromium.launch(opcoesNavegador);
    } catch (erroNavegador) {
      if (!opcoesNavegador.channel) {
        throw erroNavegador;
      }

      console.warn(
        "Microsoft Edge não disponível. Tentando o Chromium do Playwright..."
      );
      browser = await chromium.launch({ headless: executarOculto });
    }

    context = await browser.newContext({
      acceptDownloads: true,
    });

    page = await context.newPage();

    page.setDefaultTimeout(60000);

    /*
     * LOGIN
     */
    await executarComTentativas(
      "Login",
      async () => {
        await page.goto(
          "https://console.nxt4insight.com/Account/Login",
          {
            waitUntil:
              "domcontentloaded",
            timeout: 120000,
          }
        );

        const loginInput =
          page.getByRole(
            "textbox",
            {
              name:
                "Digite seu Login",
            }
          );

        const senhaInput =
          page.getByRole(
            "textbox",
            {
              name:
                "Digite sua Senha",
            }
          );

        await loginInput.waitFor({
          state: "visible",
          timeout: 60000,
        });

        await loginInput.fill(email);
        await senhaInput.fill(password);

        await page
          .getByRole("button", {
            name: "Entrar",
          })
          .click();

        await page
          .getByRole("link", {
            name:
              "CLIQUE AQUI PARA FILTRAR",
          })
          .waitFor({
            state: "visible",
            timeout: 120000,
          });

        console.log(
          "Login realizado."
        );
      },
      page
    );

    /*
     * FILTRO ORGANIZACIONAL
     */
    await executarComTentativas(
      "Filtro organizacional",
      async () => {
        const pesquisaEstrutura =
          page.locator(
            "#txtsearchorganograna"
          );

        const modalJaAberto =
          await pesquisaEstrutura
            .isVisible()
            .catch(() => false);

        if (!modalJaAberto) {
          await page
            .getByRole("link", {
              name:
                "CLIQUE AQUI PARA FILTRAR",
            })
            .click();
        }

        await pesquisaEstrutura.waitFor({
          state: "visible",
          timeout: 60000,
        });

        console.log(
          "Pesquisando ANHEMBI..."
        );

        await pesquisaEstrutura.fill(
          "ANHEMBI"
        );

        await pesquisaEstrutura.press(
          "Enter"
        );

        const modalFiltro =
          pesquisaEstrutura.locator(
            "xpath=ancestor::*[contains(@class,'modal')][1]"
          );

        await page.waitForFunction(
          () => {
            const pesquisa =
              document.querySelector(
                "#txtsearchorganograna"
              );

            if (!pesquisa) {
              return false;
            }

            const modal =
              pesquisa.closest(".modal");

            if (!modal) {
              return false;
            }

            const caixas =
              Array.from(
                modal.querySelectorAll(
                  '[role="checkbox"]'
                )
              );

            const caixasVisiveis =
              caixas.filter(
                (caixa) => {
                  const area =
                    caixa.getBoundingClientRect();

                  return (
                    area.width > 0 &&
                    area.height > 0
                  );
                }
              );

            return (
              caixasVisiveis.length >= 3
            );
          },
          null,
          {
            timeout: 60000,
          }
        );

        console.log(
          "Selecionando as tres caixas..."
        );

        const checkboxes =
          modalFiltro.getByRole(
            "checkbox"
          );

        const totalCheckboxes =
          await checkboxes.count();

        let totalSelecionadas = 0;

        for (
          let indice = 0;
          indice < totalCheckboxes;
          indice++
        ) {
          const checkbox =
            checkboxes.nth(indice);

          if (
            !(await checkbox.isVisible())
          ) {
            continue;
          }

          const treeNode =
            checkbox.locator(
              "xpath=.."
            );

          const classes =
            (await treeNode.getAttribute(
              "class"
            )) || "";

          const jaSelecionado =
            classes.includes(
              "fancytree-selected"
            );

          if (!jaSelecionado) {
            await checkbox.click();

            await page.waitForTimeout(
              300
            );
          }

          totalSelecionadas++;
        }

        if (totalSelecionadas < 3) {
          throw new Error(
            `Somente ${totalSelecionadas} caixas foram encontradas.`
          );
        }

        console.log(
          `${totalSelecionadas} caixas selecionadas.`
        );

        const salvarButton =
          modalFiltro.getByRole(
            "button",
            {
              name: /Salvar/i,
            }
          );

        await salvarButton.waitFor({
          state: "visible",
          timeout: 60000,
        });

        await salvarButton.click();

        await pesquisaEstrutura.waitFor({
          state: "hidden",
          timeout: 60000,
        });

        console.log(
          "Filtro salvo."
        );
      },
      page
    );

    /*
     * AGUARDAR O ESTOQUE ATUALIZAR
     */
    await executarComTentativas(
      "Atualizacao do estoque",
      async () => {
        const contadorAtivos =
          page.locator(
            "#qtd-total-ativos-estoque"
          );

        const totalDisponiveis =
          page.locator(
            "#qtd-total-estoque"
          );

        await contadorAtivos.waitFor({
          state: "visible",
          timeout: 120000,
        });

        await totalDisponiveis.waitFor({
          state: "visible",
          timeout: 120000,
        });

        await page.waitForFunction(
          () => {
            const contador =
              document.querySelector(
                "#qtd-total-ativos-estoque"
              );

            const total =
              document.querySelector(
                "#qtd-total-estoque"
              );

            if (!contador || !total) {
              return false;
            }

            const quantidadeAtivos =
              Number(
                (
                  contador.textContent ||
                  ""
                ).replace(/\D/g, "")
              );

            const quantidadeTotal =
              Number(
                (
                  total.textContent ||
                  ""
                ).replace(/\D/g, "")
              );

            return (
              quantidadeAtivos > 0 &&
              quantidadeTotal > 0
            );
          },
          null,
          {
            timeout: 120000,
          }
        );

        const quantidadeAtivos =
          (
            await contadorAtivos
              .textContent()
          ).trim();

        const quantidadeTotal =
          (
            await totalDisponiveis
              .textContent()
          ).trim();

        console.log(
          `Estoque: ${quantidadeAtivos} de ${quantidadeTotal} disponiveis.`
        );
      },
      page
    );

    /*
     * ABRIR O RELATORIO E AGUARDAR A TABELA
     */
    await executarComTentativas(
      "Abertura do relatorio",
      async () => {
        const tituloRelatorio =
          page.getByText(
            "ATIVOS NO ESTOQUE",
            {
              exact: true,
            }
          );

        const relatorioJaAberto =
          await tituloRelatorio
            .isVisible()
            .catch(() => false);

        if (!relatorioJaAberto) {
          const totalDisponiveis =
            page.locator(
              "#qtd-total-estoque"
            );

          await totalDisponiveis.waitFor({
            state: "visible",
            timeout: 120000,
          });

          const textoDisponiveis =
            (
              await totalDisponiveis
                .textContent()
            ).trim();

          console.log(
            `Clicando em: de ${textoDisponiveis} disponiveis`
          );

          await totalDisponiveis
            .scrollIntoViewIfNeeded();

          await totalDisponiveis.click({
            force: true,
          });
        }

        await tituloRelatorio.waitFor({
          state: "visible",
          timeout: 30000,
        });

        console.log(
          "Relatorio aberto."
        );
      },
      page
    );

    await executarComTentativas(
      "Carregamento da tabela",
      async () => {
        const painelCarregamento =
          page.locator(
            ".dx-loadpanel:visible"
          );

        await painelCarregamento
          .waitFor({
            state: "hidden",
            timeout: 120000,
          })
          .catch(() => {});

        await page.waitForFunction(
          () => {
            const linhas =
              document.querySelectorAll(
                ".dx-datagrid-rowsview .dx-data-row"
              );

            return linhas.length > 0;
          },
          null,
          {
            timeout: 120000,
          }
        );

        const totalLinhas =
          await page
            .locator(
              ".dx-datagrid-rowsview .dx-data-row"
            )
            .count();

        console.log(
          `Tabela carregada com ${totalLinhas} linhas visiveis.`
        );
      },
      page
    );

    /*
     * EXPORTAR EXCEL
     */
    const download =
      await executarComTentativas(
        "Exportacao do Excel",
        async () => {
          const seletorExportacao =
            '.dx-datagrid-export-button[aria-label="export-excel-button"]';

          const exportarButton =
            page.locator(
              seletorExportacao
            );

          await exportarButton.waitFor({
            state: "visible",
            timeout: 120000,
          });

          await page.waitForFunction(
            (seletor) => {
              const botao =
                document.querySelector(
                  seletor
                );

              return (
                botao &&
                !botao.classList.contains(
                  "dx-state-disabled"
                )
              );
            },
            seletorExportacao,
            {
              timeout: 120000,
            }
          );

          await exportarButton
            .scrollIntoViewIfNeeded();

          console.log(
            "Clicando em Exportar todos os dados..."
          );

          const downloadPromise =
            page.waitForEvent(
              "download",
              {
                timeout: 120000,
              }
            );

          await exportarButton.click({
            force: true,
          });

          return await downloadPromise;
        },
        page
      );

    /*
     * SALVAR O ARQUIVO
     */
    console.log(
      "Download iniciado."
    );

    const falhaDownload =
      await download.failure();

    if (falhaDownload) {
      throw new Error(
        `Falha no download: ${falhaDownload}`
      );
    }

    if (fs.existsSync(arquivoFinal)) {
      fs.unlinkSync(arquivoFinal);
    }

    await download.saveAs(
      arquivoFinal
    );

    if (!fs.existsSync(arquivoFinal)) {
      throw new Error(
        "A planilha nao foi encontrada."
      );
    }

    const arquivoInfo =
      fs.statSync(arquivoFinal);

    if (arquivoInfo.size === 0) {
      throw new Error(
        "A planilha esta vazia."
      );
    }

    console.log("");
    console.log(
      "Download concluido com sucesso."
    );

    console.log(
      `Arquivo: ${arquivoFinal}`
    );

    console.log(
      `Tamanho: ${(
        arquivoInfo.size / 1024
      ).toFixed(1)} KB`
    );
  } catch (error) {
    console.error("");
    console.error(
      "A automacao encontrou um erro:"
    );

    console.error(
      error instanceof Error
        ? error.message
        : String(error)
    );

    if (page) {
      const captura = path.join(
        erroDir,
        `erro-${Date.now()}.png`
      );

      await page
        .screenshot({
          path: captura,
          fullPage: true,
        })
        .catch(() => {});

      console.error(
        `Captura do erro: ${captura}`
      );
    }

    process.exitCode = 1;
  } finally {
    if (context) {
      await context
        .close()
        .catch(() => {});
    }

    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }
})();