# First Strike

Rastreador de iniciativa para Foundry VTT (PF2e) — uma faixa de retratos no
topo da tela (ou a lista vertical clássica), arrastável pra qualquer lugar e
sempre visível, pra ninguém precisar sair da ficha pra ver a ordem de turno.

## Instalação

A forma mais fácil é instalar direto pela URL do manifesto, dentro do
Foundry:

1. **Configuração e Setup → Módulos de Jogo → Instalar módulo**
2. Cole esta URL no campo **URL do Manifesto**:

   ```
   https://github.com/daember-rpg/first-strike/releases/latest/download/module.json
   ```

3. Clique em **Instalar**.

Assim que uma nova versão for publicada aqui no repositório, o Foundry
mostra o aviso de atualização disponível sozinho — não precisa baixar e
trocar a pasta manualmente.

## Requisitos

- [socketlib](https://foundryvtt.com/packages/socketlib) (obrigatório —
  é o que deixa os jogadores rolarem a própria iniciativa sem erro de
  permissão)

## O que o módulo faz

- **Faixa de iniciativa** no topo da tela: um retrato por combatente, com o
  número de iniciativa no canto, o ativo maior e com brilho dourado, e a
  etiqueta **Next** em quem age depois. Se a luta for maior que a tela,
  a faixa rola de lado (a roda do mouse também funciona). O ícone no canto
  do painel alterna entre a faixa e a lista vertical.
- **Aviso de turno**: um banner "Your turn" com um brilho suave nas bordas
  da tela quando chega a sua vez, e um banner menor "You're up next" quando
  você é o próximo. Dá pra trocar nas configurações do módulo (só meus
  turnos, todos os turnos, ou desligado).
- **Barra de fim de turno** logo abaixo da faixa pro jogador ativo: **Delay**
  e **End turn**, sem caçar ícone pequeno.
- **Esconder nomes de inimigos** (configuração do mundo, desligada por
  padrão): os jogadores veem criaturas hostis que não são deles como
  "Unknown creature" com retrato em branco.
- Clicar num retrato leva a câmera até o token (o jogador só vai até tokens
  que ele já enxerga).
- Mostra o combatente ativo em destaque, com HP visível pro GM sempre, e
  pros jogadores só dos próprios personagens e dos aliados (nunca dos
  monstros).
- Inimigos derrotados ficam acinzentados e são pulados automaticamente —
  voltam se forem curados.
- Inimigos escondidos (token oculto) rolam iniciativa mas ficam
  totalmente invisíveis pros jogadores, e também são pulados.
- Botão **Begin Encounter** → **End Encounter**, sem forçar rolagem de
  iniciativa; pega o combate não importa como ele foi criado (botão
  próprio ou menu nativo do Foundry).
- GM pode editar a iniciativa de qualquer um com duplo clique.
- Ação de **delay/segurar ação** e **agir agora**.
- Botão de **end turn** pro próprio jogador passar a vez sem depender do
  GM.
- Marca "surpreso" (não age na rodada 1), destaque de "próximos a agir",
  atalhos de teclado (`[` e `]`) para turno anterior/seguinte e botão de
  rolar iniciativa de todos os NPCs de uma vez.
- Marca o token como morto (status nativo do Foundry) ao chegar a 0 HP, e
  limpa ao curar — pensado para integrar com módulos de loot que só devem
  disparar no fim real do combate (`firstStrike.combatEnded`).

## Para desenvolvimento

Visual no padrão **Embermark**, compartilhado com Triad e Kronos (fontes
Cinzel/Spectral, vidro fosco, paleta dourado/ember/musgo).

O First Strike não se encaixa mais na aba de Iniciativa do Triad: trocar de
aba fazia o jogador perder a ficha de vista. O Triad ainda pode usar a API
`game.modules.get("first-strike").api.requestRollInitiative` pra rolar
iniciativa pelo mesmo relay do GM.
