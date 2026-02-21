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

    // Lista de funções exportadas para o lado do CLIENTE (browser)
    obj.exports = ['onDeviceRefreshEnd'];

    // Inicialização do servidor
    obj.server_startup = function () {};

    // FUNÇÃO CLIENTE (browser)  chamada quando o painel de dispositivo
    // termina de carregar. Registra a aba "Software" e injeta o iframe.
    obj.onDeviceRefreshEnd = function () {
        pluginHandler.registerPluginTab({
            tabTitle: 'Software',
            tabId: 'pluginSoftwareInventory'
        });

        var nid = (typeof currentNodeId !== 'undefined') ? currentNodeId : '';

        QA('pluginSoftwareInventory',
            '<iframe id="pluginIframeSoftwareInventory"' +
            ' style="width:100%;height:720px;overflow:auto;border:none"' +
            ' frameborder="0"' +
            ' src="/pluginadmin.ashx?pin=softwareinventory&user=1&nodeid=' + encodeURIComponent(nid) + '">' +
            '</iframe>'
        );
    };

    // Manipulador HTTP via /pluginadmin.ashx?pin=softwareinventory
    obj.handleAdminReq = function (req, res, user) {

        if (req.query.user != 1) {
            res.sendStatus(401);
            return;
        }

        // Endpoint de dados JSON
        if (req.query.action === 'data') {
            var nodeId = req.query.nodeid;
            if (!nodeId) return res.json({ success: false, error: 'nodeid ausente', softwares: [] });

            getSoftwareData(nodeId, function (err, softwares, source) {
                if (err) return res.json({ success: false, error: err.message, softwares: [] });
                res.json({
                    success: true,
                    source: source,
                    count: softwares.length,
                    softwares: softwares
                });
            });
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
