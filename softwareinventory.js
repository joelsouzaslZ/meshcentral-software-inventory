'use strict';

/**
 * MeshCentral Plugin: Software Inventory
 * Exibe todos os programas instalados nos dispositivos gerenciados.
 *
 * Padrão obrigatório do MeshCentral:
 *   - module.exports.<shortName> = function(parent)
 *   - obj.exports = ['nomeDaFuncaoClienteSide']
 *   - obj.onDeviceRefreshEnd()  roda no BROWSER para registrar a aba
 *   - obj.handleAdminReq(req, res, user)  serve HTML/dados via /pluginadmin.ashx
 *   - obj.server_startup()  inicialização no servidor
 */
module.exports.softwareinventory = function (parent) {

    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.pluginName = 'softwareinventory';
    obj.VIEWS = __dirname + '/views/';

    // Mapa de requisições aguardando resposta ao vivo do agente { nodeId -> {res, timer} }
    obj._pending = {};

    // Lista de funções exportadas para o lado do CLIENTE (browser)
    obj.exports = ['onDeviceRefreshEnd'];

    // Hook server-side correto do pluginHandler: hook_processAgentData(command, agentObj)
    // Captura a resposta do console 'installedapps' e resolve requisição pendente (se houver).
    obj.hook_processAgentData = function (command, agentObj) {
        if (!command) return;
        if (command.action !== 'msg' || command.type !== 'console') return;

        var nodeId = (agentObj && agentObj.dbNodeKey) || '';
        if (!nodeId) return;
        var pending = obj._pending[nodeId];
        if (!pending) return;

        var rawVal = command.value || command.data || '';
        if (typeof rawVal !== 'string' || rawVal.indexOf('[') === -1) return;

        clearTimeout(pending.timer);
        delete obj._pending[nodeId];

        var list = [];
        try {
            var val = rawVal;
            var start = val.indexOf('[');
            if (start !== -1) val = val.slice(start);
            list = JSON.parse(val);
            if (!Array.isArray(list)) list = [];
        } catch (e) { list = []; }

        // Persiste no banco como sw<nodeId> para requisições futuras (cache)
        var db = obj.meshServer.db;
        if (db && typeof db.Set === 'function') {
            db.Set({ _id: 'sw' + nodeId, type: 'softwares', list: list, ts: Date.now() }, function () {});
        }

        var normalized = normalizeList(list);
        pending.res.json({
            success: true,
            source: 'agent-live',
            count: normalized.length,
            softwares: normalized
        });
    };

    // Inicialização do servidor
    obj.server_startup = function () {};

    // FUNÇÃO CLIENTE (browser)  chamada quando o painel de dispositivo
    // termina de carregar. Registra a aba "Software" e injeta o iframe.
    obj.onDeviceRefreshEnd = function () {
        pluginHandler.registerPluginTab({
            tabTitle: 'Software',
            tabId: 'pluginSoftwareInventory'
        });

        // MeshCentral 1.1.x usa currentNode._id; versões anteriores usam currentNodeId
        var nid = '';
        try { if (typeof currentNode !== 'undefined' && currentNode && currentNode._id) nid = currentNode._id; } catch(e){}
        try { if (!nid && typeof currentNodeId !== 'undefined' && currentNodeId) nid = currentNodeId; } catch(e){}
        try { if (!nid && typeof device !== 'undefined' && device && device._id) nid = device._id; } catch(e){}

        QA('pluginSoftwareInventory',
            '<iframe id="pluginIframeSoftwareInventory"' +
            ' style="width:100%;height:720px;overflow:auto;border:none"' +
            ' frameborder="0"' +
            ' src="/pluginadmin.ashx?pin=softwareinventory&user=1&nodeid=' + encodeURIComponent(nid) + '">' +
            '</iframe>'
        );

        // Garantia: envia nodeId via postMessage ao iframe depois de carregado
        // (cobre casos onde o src foi gerado sem nodeId)
        if (nid) {
            setTimeout(function () {
                var iframe = document.getElementById('pluginIframeSoftwareInventory');
                if (iframe && iframe.contentWindow) {
                    try { iframe.contentWindow.postMessage({ type: 'mc-nodeid', nodeid: nid }, window.location.origin); } catch (e) {}
                }
            }, 800);
        }
    };

    // Manipulador HTTP via /pluginadmin.ashx?pin=softwareinventory
    obj.handleAdminReq = function (req, res, user) {

        if (req.query.user != 1) {
            res.sendStatus(401);
            return;
        }

        // Endpoint de dados JSON — tenta DB primeiro; se vazio, solicita ao agente ao vivo
        if (req.query.action === 'data') {
            var nodeId = req.query.nodeid;
            if (!nodeId) return res.json({ success: false, error: 'nodeid ausente', softwares: [] });

            getSoftwareData(nodeId, function (err, softwares, source) {
                // Se banco já tem dados, retorna imediatamente
                if (!err && softwares && softwares.length > 0) {
                    return res.json({ success: true, source: source, count: softwares.length, softwares: softwares });
                }

                // Banco vazio — tentar buscar ao vivo via WebSocket do agente
                var wsagents = obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
                var agentConn = wsagents && (wsagents[nodeId] || wsagents['node/' + nodeId]);

                if (!agentConn || typeof agentConn.send !== 'function') {
                    // Agente offline ou API indisponível — retorna vazio com aviso
                    return res.json({ success: true, source: 'empty', count: 0, softwares: [],
                        message: 'Agente offline ou dados ainda não coletados. Aguarde sincronização.' });
                }

                // Registra a requisição como pendente; onAgentMessage vai resolvê-la
                obj._pending[nodeId] = {
                    res: res,
                    timer: setTimeout(function () {
                        if (obj._pending[nodeId]) {
                            delete obj._pending[nodeId];
                            res.json({ success: true, source: 'timeout', count: 0, softwares: [],
                                message: 'Agente não respondeu em tempo hábil. Tente novamente.' });
                        }
                    }, 12000)
                };

                try {
                    // Formato correto: console command ao agente
                    // O agente responde com {action:'msg', type:'console', value:'[{...}]', sessionid:...}
                    agentConn.send(JSON.stringify({
                        action: 'msg',
                        type: 'console',
                        value: 'installedapps',
                        sessionid: 'si-' + nodeId,
                        rights: 0xFFFFFFFF
                    }));
                } catch (ex) {
                    clearTimeout(obj._pending[nodeId].timer);
                    delete obj._pending[nodeId];
                    res.json({ success: false, error: 'Falha ao enviar comando ao agente: ' + ex.message, softwares: [] });
                }
            });
            return;
        }

        // Endpoint push: agente envia dados via POST JSON; plugin salva como sw<nodeId>
        if (req.query.action === 'push') {
            var nid = req.query.nodeid || '';
            if (!nid) return res.json({ success: false, error: 'nodeid ausente' });
            var body = req.body || null;
            if (!body || !body.softwares) return res.json({ success: false, error: 'payload inválido' });
            var dbPush = obj.meshServer.db;
            if (!dbPush || typeof dbPush.Set !== 'function') {
                return res.json({ success: false, error: 'db.Set indisponível' });
            }
            try {
                dbPush.Set({ _id: 'sw' + nid, type: 'softwares', list: body.softwares, ts: Date.now() }, function (e) {
                    if (e) return res.json({ success: false, error: String(e) });
                    // Resolve pendente se houver (ex: requisição simultânea)
                    if (obj._pending[nid]) {
                        clearTimeout(obj._pending[nid].timer);
                        var p = obj._pending[nid];
                        delete obj._pending[nid];
                        var norm = normalizeList(body.softwares);
                        p.res.json({ success: true, source: 'push', count: norm.length, softwares: norm });
                    }
                    res.json({ success: true });
                });
            } catch (ex) { return res.json({ success: false, error: ex.message || String(ex) }); }
            return;
        }

        // Servir arquivos estáticos (ícones)
        if (req.query.include != null) {
            var path = require('path');
            var safePath = path.join(__dirname, 'public', req.query.include);
            if (!safePath.startsWith(__dirname)) { res.sendStatus(403); return; }
            res.sendFile(safePath);
            return;
        }

        // View principal (iframe)
        var nodeId = req.query.nodeid || '';
        res.render(obj.VIEWS + 'device', {
            nodeid: nodeId,
            pluginPin: 'softwareinventory'
        });
    };

    // Busca de dados de software via banco interno do MeshCentral
    function getSoftwareData(nodeId, callback) {
        var db = obj.meshServer.db;

        if (!db || typeof db.Get !== 'function') {
            return callback(new Error('Banco de dados indisponivel'), [], 'none');
        }

        // Estrategia 1: campo "softwares" no documento do node
        db.Get(nodeId, function (err, docs) {
            if (!err && docs && docs.length > 0) {
                var node = docs[0];
                var raw = node.softwares
                    || node.softwareinfo
                    || (node.agent && node.agent.softwares)
                    || null;

                if (raw && raw.length > 0) {
                    return callback(null, normalizeList(raw), 'node-document');
                }
            }

            // Estrategia 2: documento "sw" + nodeId
            db.Get('sw' + nodeId, function (err2, docs2) {
                if (!err2 && docs2 && docs2.length > 0) {
                    var swDoc = docs2[0];
                    var raw2 = swDoc.list || swDoc.softwares || swDoc.data || [];
                    if (raw2.length > 0) {
                        return callback(null, normalizeList(raw2), 'sw-document');
                    }
                }

                // Estrategia 3: query por tipo no banco
                if (typeof db.GetAllTypeNodeFiltered === 'function') {
                    // Assinatura: GetAllTypeNodeFiltered(nodes, domain, type, id, func)
                    // Passar domain vazio (global), type = 'softwares', id = nodeId
                    db.GetAllTypeNodeFiltered(['softwares'], '', 'softwares', nodeId, function (err3, docs3) {
                        if (!err3 && docs3 && docs3.length > 0) {
                            var raw3 = docs3[0].list || docs3[0].softwares || docs3[0].data || [];
                            if (raw3.length > 0) {
                                return callback(null, normalizeList(raw3), 'type-query');
                            }
                        }
                        callback(null, [], 'empty');
                    });
                } else {
                    callback(null, [], 'empty');
                }
            });
        });
    }

    function normalizeList(rawList) {
        if (!Array.isArray(rawList)) return [];

        return rawList
            .filter(function (item) { return item && (item.name || item.displayName); })
            .map(function (item) {
                return {
                    name: item.name || item.displayName || '',
                    version: item.version || item.displayVersion || '',
                    publisher: item.publisher || item.vendor || item.company || '',
                    installDate: formatDate(item.installdate || item.installDate || item.date || ''),
                    installDateRaw: item.installdate || item.installDate || item.date || '',
                    installLocation: item.installLocation || item.location || item.path || '',
                    installSize: formatSize(item.installSize || item.size || 0),
                    installSizeRaw: parseInt(item.installSize || item.size || 0, 10),
                    architecture: item.architecture || item.arch || detectArch(item),
                    systemComponent: !!(item.systemComponent || item.system)
                };
            })
            .sort(function (a, b) {
                return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            });
    }

    function formatDate(raw) {
        if (!raw) return '';
        if (/^\d{8}$/.test(raw)) {
            return raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
        }
        return raw;
    }

    function formatSize(bytes) {
        if (!bytes || bytes === 0) return '';
        var kb = parseInt(bytes, 10);
        if (isNaN(kb) || kb === 0) return '';
        if (kb < 1024) return kb + ' KB';
        if (kb < 1024 * 1024) return (kb / 1024).toFixed(1) + ' MB';
        return (kb / (1024 * 1024)).toFixed(2) + ' GB';
    }

    function detectArch(item) {
        var raw = JSON.stringify(item).toLowerCase();
        if (raw.indexOf('x64') !== -1 || raw.indexOf('64-bit') !== -1 || raw.indexOf('amd64') !== -1) return 'x64';
        if (raw.indexOf('x86') !== -1 || raw.indexOf('32-bit') !== -1) return 'x86';
        return '';
    }

    return obj;
};
