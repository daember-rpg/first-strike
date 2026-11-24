# First Strike

Rastreador de iniciativa para Foundry VTT (PF2e) — uma faixa de retratos no
topo da tela, arrastável pra qualquer lugar e
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

- **Faixa de iniciativa** no topo da tela, numa única barra fina: um retrato
  por combatente (todos do mesmo tamanho), com a iniciativa embaixo, o ativo
  com anel dourado e o nome de quem está agindo na ponta esquerda, e a
  etiqueta **Next** (bem legível, com contorno tracejado) só no próximo. O nome de qualquer um aparece ao passar
  o mouse. Se a luta for maior que a tela, a faixa rola de lado (a roda do
  mouse também funciona). Os controles do GM ficam numa pílula discreta embaixo
  dos retratos, esmaecida até o mouse chegar nela. (A lista vertical foi
  removida: não combinava com o novo visual.)
- **Aviso de turno**: um banner "Your turn" com um brilho suave nas bordas
  da tela quando chega a sua vez, e um banner menor "You're up next" quando
  você é o próximo. Dá pra trocar nas configurações do módulo (só meus
  turnos, todos os turnos, ou desligado).
- **Delay** e **End turn** viram dois botões redondos na própria barra,
  só enquanto é a vez de quem pode agir.
- **Rolar iniciativa dos inimigos automaticamente** (configuração do mundo,
  ligada por padrão): ao entrar no combate, criaturas sem dono jogador têm a
  iniciativa rolada na hora (secreta, só o GM vê). Jogadores continuam rolando
  os próprios dados. Desligue nas configurações do módulo para rolar à mão.
- **Esconder nomes de inimigos** (configuração do mundo, desligada por
  padrão): os jogadores veem criaturas hostis que não são deles como
  "Unknown creature" com retrato em branco.
- **Acessibilidade**: tudo que é clicável também funciona pelo teclado
  (Tab, Enter ou Espaço), os retratos têm descrição para leitor de tela
  (iniciativa, turno atual, próximo, HP), o aviso de turno é anunciado, e
  as animações respeitam a opção de reduzir movimento do sistema.
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

## Visual 1.6

A barra virou uma fileira de retratos redondos flutuando, sem container. O
turno atual fica maior, com anel dourado e o nome embaixo; o próximo tem uma
setinha dourada; aliados têm anel azul liso e inimigos anel vermelho com folga
escura (não depende só da cor). O round aparece como um disquinho "R5" no
começo da fila e serve de alça para arrastar. Nomes dos demais aparecem ao
passar o mouse; o número de iniciativa é sempre visível para o GM e, para
jogadores, ao passar o mouse. As ferramentas do GM ficam numa pílula discreta
embaixo, que ganha força quando o mouse chega perto.

## Qualidade de vida (1.7)

- **Menu com botão direito (GM):** clique com o botão direito num retrato para
  definir ou editar a iniciativa, rolar de novo, marcar como derrotado ou vivo,
  esconder ou revelar dos jogadores, abrir a ficha ou remover do encontro.
  Dar dois cliques no número da iniciativa continua funcionando.
- **Ordem automática:** se você muda a iniciativa de alguém **antes de qualquer
  turno ter sido jogado** (rodada 1, turno ainda no primeiro da fila), o turno
  passa para quem ficou em primeiro. Depois que o jogo andou, mudar um número
  só reordena a fila: o turno continua com quem está agindo.

## Novidades da 1.8

- **Inimigos iguais agrupados:** inimigos vizinhos do mesmo tipo (por exemplo,
  quatro goblins em sequência) viram um retrato só com um contador (×4). Clique
  nele para abrir o grupo; o botão pequeno no primeiro retrato do grupo aberto
  fecha de novo. O grupo fica sempre aberto enquanto um de seus membros estiver
  agindo, para o turno ser exato. É uma preferência de cada pessoa
  (Configurações → "Group identical enemies").
- **Lembretes de round (GM):** o botão de sino na pílula de ferramentas abre um
  painel para criar lembretes ("o efeito de lentidão termina") para daqui a N
  rounds, uma vez ou repetindo a cada N rounds. Quando o round começa, o
  lembrete aparece no chat (só para o GM, ou para todos se você marcar "Tell the
  players") e como aviso na tela.
- **Câmera que acompanha o turno:** o botão de câmera na pílula (ou a
  configuração "Follow the turn with the camera") faz o mapa deslizar até quem
  está agindo a cada turno. Jogadores só são levados a tokens que conseguem ver.

## Novidades da 1.9

- **Destaque no mapa:** passe o mouse num retrato e o token dele acende no mapa
  (num grupo, acendem todos). Jogadores só veem isso para tokens que enxergam.
- **Atalhos de teclado:** `Shift+N` encerra o turno e `Shift+D` adia o turno de
  quem está agindo, para quem controla o personagem (o GM sempre pode). Dá para
  trocar as teclas em Configurar Controles.
- **Som na sua vez (opcional):** um sininho curto quando começa o turno de um
  personagem seu. Fica desligado por padrão (Configurações → "Play a sound on
  your turn").
- **Adicionar tokens ao combate (GM):** selecione tokens no mapa e use o botão
  de "adicionar pessoa" na pílula de ferramentas para colocá-los no combate em
  andamento (reforços, invocações). Quem já está no combate é ignorado, e os
  inimigos têm a iniciativa rolada pela configuração de rolagem automática.
