# Changelog

## [1.1.0] - 2026-02-23
### Adicionado
- Botão **Desinstalar** em cada linha da tabela de softwares
- Modal de confirmação antes de iniciar a desinstalação remota
- Endpoint `action=uninstall`: envia `uninstallapplication` ao agente via WebSocket com `rights: 0xFFFFFFFF`
- Hook `hook_processAgentData` agora captura também respostas de desinstalação (sessionid `su-`)
- Cache `sw<nodeId>` invalidado automaticamente após desinstalação confirmada
- Aba renomeada de "Software" para "Programas"
- Reload automático da lista 5 s após desinstalar para refletir a remoção

### Corrigido
- `hook_processAgentData` com assinatura correta conforme pluginHandler do MeshCentral
- `rights: 0xFFFFFFFF` adicionado ao envio de comandos (agente verificava esse campo)
- Prefixo `su-` em sessionid para distinguir respostas de desinstalar das de listagem

## [1.0.0] - 2026-02-21
- Inventário completo de softwares instalados via agent MeshCentral
- Exibição de: nome, versão, publisher, data de instalação, tamanho, arquitetura (x64/x86), tipo (sistema/usuário) e local de instalação
- Busca em tempo real por nome, publisher e versão
- Filtros por arquitetura e tipo de software
- Ordenação por qualquer coluna
- Paginação configurável (25 / 50 / 100 / 250 por página)
- Exportação para CSV (UTF-8, compatível com Excel)
- Mapeamento automático de ícones por publisher conhecido
- Cache em memória com TTL de 3 minutos
- Estratégia de 3 camadas para busca de dados: cache → banco do MeshCentral → agent
- Botão de atualização forçada (bypass de cache)
- Estados de interface: carregando, erro, vazio e dados
