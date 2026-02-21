'use strict';

/**
 * MeshCentral Plugin: Software Inventory
 * Exibe todos os programas instalados nos dispositivos gerenciados,
 * incluindo nome, versão, publisher, data de instalação, tamanho e caminho.
 */
module.exports = function (parent) {

    const obj = {};
    obj.parent = parent;
    obj.pluginName = 'softwareinventory';

    // ─────────────────────────────────────────────────────────────────
    // Cache em memória: nodeId → { data: [], timestamp: number }
    // ─────────────────────────────────────────────────────────────────
    const cache = new Map();
    const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutos

    // Requisições pendentes aguardando resposta do agent:
    // nodeId → { resolve, reject, timer }
    const pending = new Map();

    // ─────────────────────────────────────────────────────────────────
    // Exportações do plugin (registra a aba no painel de dispositivo)
    // ─────────────────────────────────────────────────────────────────
    obj.exports = {
        deviceTabs: [
            {
                tab: 'softwareinventory',
                title: 'Software',
                icon: 'icons/default.png',
                url: 'softwareinventory/device',
                permission: 1
            }
        ]
    };

    // ─────────────────────────────────────────────────────────────────
    // Rota 1: renderiza a view HTML da aba
    // ─────────────────────────────────────────────────────────────────
    parent.app.get('/plugins/softwareinventory/device', function (req, res) {
        if (!req.query.id) {
            return res.status(400).send('Device ID ausente.');
        }
        res.render(__dirname + '/views/device.handlebars', {
            deviceid: req.query.id,
            pluginRoot: '/plugins/softwareinventory'
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Rota 2: serve arquivos estáticos (ícones, CSS, JS)
    // ─────────────────────────────────────────────────────────────────
    const express = require('express');
    parent.app.use('/plugins/softwareinventory', express.static(__dirname + '/public'));

    // ─────────────────────────────────────────────────────────────────
    // Rota 3: endpoint principal de dados de software
    // GET /plugins/softwareinventory/device/data?id=<nodeId>&refresh=1
    // ─────────────────────────────────────────────────────────────────
    parent.app.get('/plugins/softwareinventory/device/data', async function (req, res) {

        const nodeId = req.query.id;
        const forceRefresh = req.query.refresh === '1';

        if (!nodeId) {
            return res.status(400).json({ error: 'Parâmetro id é obrigatório.' });
        }

        // 1. Verificar cache (se não for refresh forçado)
        if (!forceRefresh) {
            const cached = cache.get(nodeId);
            if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
                return res.json({
                    success: true,
                    source: 'cache',
                    timestamp: cached.timestamp,
                    count: cached.data.length,
                    softwares: cached.data
                });
            }
        }

        // 2. Tentar obter do banco de dados do MeshCentral (snapshot mais recente)
        try {
            const fromDb = await getFromDatabase(nodeId);
            if (fromDb && fromDb.length > 0) {
                const payload = normalizeList(fromDb);
                cache.set(nodeId, { data: payload, timestamp: Date.now() });
                return res.json({
                    success: true,
                    source: 'database',
                    timestamp: Date.now(),
                    count: payload.length,
                    softwares: payload
                });
            }
        } catch (dbErr) {
            // DB não retornou dados, continua para consultar o agent
        }

        // 3. Solicitar dados diretamente ao agent (polling com timeout)
        try {
            const agentData = await requestFromAgent(nodeId);
            const payload = normalizeList(agentData);
            cache.set(nodeId, { data: payload, timestamp: Date.now() });
            return res.json({
                success: true,
                source: 'agent',
                timestamp: Date.now(),
                count: payload.length,
                softwares: payload
            });
        } catch (agentErr) {
            return res.status(504).json({
                success: false,
                error: 'Não foi possível obter dados do dispositivo: ' + agentErr.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────────────
    // Rota 4: invalida o cache de um dispositivo específico
    // POST /plugins/softwareinventory/device/refresh?id=<nodeId>
    // ─────────────────────────────────────────────────────────────────
    parent.app.post('/plugins/softwareinventory/device/refresh', function (req, res) {
        const nodeId = req.query.id;
        if (!nodeId) return res.status(400).json({ error: 'id é obrigatório' });
        cache.delete(nodeId);
        res.json({ success: true, message: 'Cache limpo para ' + nodeId });
    });

    // ─────────────────────────────────────────────────────────────────
    // Ouvir respostas do agent via evento do webserver (se disponível)
    // ─────────────────────────────────────────────────────────────────
    if (parent.webserver && typeof parent.webserver.on === 'function') {
        parent.webserver.on('agentData', function (data) {
            if (data && data.action === 'installedapps' && data.nodeid) {
                const resolve_ = pending.get(data.nodeid);
                if (resolve_) {
                    clearTimeout(resolve_.timer);
                    pending.delete(data.nodeid);
                    try {
                        const list = typeof data.result === 'string'
                            ? JSON.parse(data.result)
                            : data.result;
                        resolve_.resolve(list || []);
                    } catch (e) {
                        resolve_.resolve([]);
                    }
                }
                // Atualiza cache mesmo para requests não pendentes (push do agent)
                if (data.result) {
                    try {
                        const list = typeof data.result === 'string'
                            ? JSON.parse(data.result)
                            : data.result;
                        const payload = normalizeList(list || []);
                        cache.set(data.nodeid, { data: payload, timestamp: Date.now() });
                    } catch (_) { /* ignore */ }
                }
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Helpers internos
    // ─────────────────────────────────────────────────────────────────

    /**
     * Busca informações de software do banco do MeshCentral.
     * O MeshCentral armazena dados do dispositivo no node document.
     */
    function getFromDatabase(nodeId) {
        return new Promise(function (resolve, reject) {
            if (!parent.db || typeof parent.db.Get !== 'function') {
                return reject(new Error('DB indisponível'));
            }
            parent.db.Get(nodeId, function (err, docs) {
                if (err || !docs || docs.length === 0) {
                    return reject(new Error('Node não encontrado no DB'));
                }
                const node = docs[0];
                // MeshCentral pode armazenar softwares em campos diferentes
                const softwares =
                    node.softwares ||
                    node.softwareinfo ||
                    (node.agent && node.agent.softwares) ||
                    null;
                if (softwares && softwares.length > 0) {
                    return resolve(softwares);
                }
                reject(new Error('Nenhum dado de software no DB'));
            });
        });
    }

    /**
     * Envia comando ao agent e aguarda resposta (com timeout de 30 s).
     */
    function requestFromAgent(nodeId) {
        return new Promise(function (resolve, reject) {

            // Verificar se o dispositivo possui sessão ativa
            const ws = getAgentSocket(nodeId);
            if (!ws) {
                return reject(new Error('Dispositivo offline ou sem sessão ativa'));
            }

            // Montar promise de espera
            const timer = setTimeout(function () {
                pending.delete(nodeId);
                reject(new Error('Timeout aguardando resposta do agent (30s)'));
            }, 30000);

            pending.set(nodeId, { resolve, reject, timer });

            // Enviar comando ao agent
            try {
                const cmd = JSON.stringify({
                    action: 'installedapps',
                    nodeid: nodeId,
                    type: 0
                });
                ws.send(cmd);
            } catch (sendErr) {
                clearTimeout(timer);
                pending.delete(nodeId);
                reject(new Error('Falha ao enviar comando: ' + sendErr.message));
            }
        });
    }

    /**
     * Tenta localizar o WebSocket ativo do agent para o nodeId fornecido.
     * MeshCentral mantém as sessões em parent.webserver.wsagents ou similar.
     */
    function getAgentSocket(nodeId) {
        const wss = parent.webserver;
        if (!wss) return null;

        // Tabela principal de agents conectados (nome pode variar por versão)
        const tables = [
            wss.wsagents,
            wss.wssessions,
            wss.agentwsstable,
            wss.agentconnections
        ];

        for (const table of tables) {
            if (table && table[nodeId]) return table[nodeId];
        }
        return null;
    }

    /**
     * Normaliza e enriquece a lista de softwares retornada pelo agent.
     * Garante campos consistentes independentemente do SO/formato.
     */
    function normalizeList(rawList) {
        if (!Array.isArray(rawList)) return [];

        return rawList
            .filter(function (item) { return item && item.name; })
            .map(function (item) {
                return {
                    name: item.name || item.displayName || '',
                    version: item.version || item.displayVersion || '',
                    publisher: item.publisher || item.vendor || item.company || '',
                    installDate: formatDate(item.installDate || item.date || ''),
                    installDateRaw: item.installDate || item.date || '',
                    installLocation: item.installLocation || item.location || item.path || '',
                    installSize: formatSize(item.installSize || item.size || 0),
                    installSizeRaw: parseInt(item.installSize || item.size || 0, 10),
                    uninstallString: item.uninstallString || '',
                    architecture: item.architecture || item.arch || detectArch(item),
                    systemComponent: !!item.systemComponent,
                    source: item.source || detectSource(item)
                };
            })
            .sort(function (a, b) {
                return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            });
    }

    function formatDate(raw) {
        if (!raw) return '';
        // Formato YYYYMMDD (comum no Windows registry)
        if (/^\d{8}$/.test(raw)) {
            return raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
        }
        return raw;
    }

    function formatSize(bytes) {
        if (!bytes || bytes === 0) return '';
        const kb = parseInt(bytes, 10);
        if (isNaN(kb) || kb === 0) return '';
        if (kb < 1024) return kb + ' KB';
        if (kb < 1024 * 1024) return (kb / 1024).toFixed(1) + ' MB';
        return (kb / (1024 * 1024)).toFixed(2) + ' GB';
    }

    function detectArch(item) {
        const raw = JSON.stringify(item).toLowerCase();
        if (raw.includes('x64') || raw.includes('64-bit') || raw.includes('amd64')) return 'x64';
        if (raw.includes('x86') || raw.includes('32-bit')) return 'x86';
        return '';
    }

    function detectSource(item) {
        if (item.registryKey) return 'Windows Registry';
        if (item.packageManager) return item.packageManager;
        return '';
    }

    return obj;
};
