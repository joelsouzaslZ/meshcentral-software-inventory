# MeshCentral Software Inventory Plugin

Plugin para [MeshCentral](https://github.com/Ylianst/MeshCentral) que exibe todos os softwares instalados nos dispositivos gerenciados, com ícones, versões e informações detalhadas coletadas nativamente pelos agents.

---

## Instalação

### Pré-requisito: habilitar plugins no MeshCentral

No arquivo `config.json` do MeshCentral:

```json
"plugins": {
    "enabled": true
}
```

Reinicie o servidor após essa alteração.

### Instalar o plugin

No painel administrativo do MeshCentral, acesse **Plugins → Add Plugin** e cole a URL:

```
https://raw.githubusercontent.com/joelsouzaslZ/meshcentral-software-inventory/master/config.json
```

---

## Funcionalidades

| Recurso | Descrição |
|---|---|
| **Inventário completo** | Nome, versão, publisher, data de instalação, tamanho, arquitetura, tipo e local de instalação |
| **Busca em tempo real** | Filtra por nome, publisher e versão simultaneamente |
| **Filtros** | Arquitetura (x64 / x86) e tipo (Sistema / Usuário) |
| **Ordenação** | Clique em qualquer coluna para ordenar asc/desc |
| **Paginação** | 25 / 50 / 100 / 250 itens por página |
| **Exportar CSV** | UTF-8 com BOM — abre corretamente no Excel |
| **Ícones automáticos** | Mapeamento por publisher: Microsoft, Google, Adobe, Mozilla, Git, VLC, Zoom, Slack, Discord e outros |
| **Cache inteligente** | TTL de 3 minutos, atualização forçada disponível |
| **3 camadas de dados** | Cache → Banco do MeshCentral → Agent em tempo real |

---

## Como funciona

O plugin registra uma nova aba **"Software"** em cada dispositivo gerenciado. Ao acessar a aba:

1. Verifica se há dados em cache (válidos por 3 minutos)
2. Se não houver, consulta o banco de dados interno do MeshCentral
3. Se não encontrar, envia um comando `installedapps` direto ao agent e aguarda a resposta (timeout de 30s)

Os dados são normalizados para exibição consistente independentemente do sistema operacional.

---

## Estrutura do projeto

```
meshcentral-software-inventory/
├── config.json          ← Identificação do plugin para o MeshCentral (obrigatório)
├── package.json
├── index.js             ← Backend Node.js
├── changelog.md
├── views/
│   └── device.handlebars  ← Frontend da aba de dispositivo
└── public/
    └── icons/
        └── default.png  ← Ícone fallback
```

---

## Compatibilidade

- MeshCentral >= 1.1.0
- Windows (lê o registro: `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`)
- Linux (suporte via agent quando disponível)
- macOS (suporte via agent quando disponível)

---

## Licença

MIT
