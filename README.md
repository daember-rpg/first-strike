# First Strike

Rastreador de iniciativa para Foundry VTT (PF2e) — fluido, arrastável, pode
ficar flutuando em qualquer lugar da tela ou dockado dentro da aba de
Iniciativa do [Triad](https://github.com/daember-rpg/triad).

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
- [Triad](https://github.com/daember-rpg/triad) (opcional — se estiver
  ativo, o First Strike doca automaticamente na aba de Iniciativa dele)

## O que o módulo faz

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
  atalhos de teclado (`[` e `]`) para turno anterior/seguinte, botão de
  rolar iniciativa de todos os NPCs de uma vez, e um modo compacto
  mostrando só o ativo + o próximo.
- Marca o token como morto (status nativo do Foundry) ao chegar a 0 HP, e
  limpa ao curar — pensado para integrar com módulos de loot que só devem
  disparar no fim real do combate (`firstStrike.combatEnded`).

## Para desenvolvimento

Visual no padrão **Embermark**, compartilhado com Triad e Kronos (fontes
Cinzel/Spectral, vidro fosco, paleta dourado/ember/musgo). Quando dockado
no Triad, lê as variáveis de cor reais do Triad em vez de ter cópia
própria — qualquer ajuste de paleta no Triad se reflete aqui também.
