import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

function parseSetting(settings, key, fallback) {
    try {
        return JSON.parse(settings.get_string(key) || JSON.stringify(fallback));
    } catch (e) {
        return fallback;
    }
}

function flattenValues(value, prefix = '', result = []) {
    if (value === null || value === undefined)
        return result;

    if (Array.isArray(value)) {
        value.forEach((item, index) => flattenValues(item, `${prefix}[${index}]`, result));
    } else if (typeof value === 'object') {
        Object.entries(value).forEach(([key, item]) => {
            flattenValues(item, prefix ? `${prefix}.${key}` : key, result);
        });
    } else if (prefix) {
        result.push({ id: prefix, value });
    }

    return result;
}

function formatValue(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    return String(value);
}

function addAuthorization(message, user, password) {
    if (user || password) {
        const bytes = new TextEncoder().encode(`${user}:${password}`);
        message.request_headers.append('Authorization', `Basic ${GLib.base64_encode(bytes)}`);
    }
}

const EvccIndicator = GObject.registerClass({
    GTypeName: 'EvccIndicator',
}, class EvccIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'evcc');
        this._extension = extension;
        this._session = new Soup.Session();
        this._labels = new Map();
        this._topBox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        this.add_child(this._topBox);

        this._rebuild();
        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _rebuild() {
        const settings = this._extension.getSettings();
        this._url = settings.get_string('evcc-url').replace(/\/$/, '');
        this._user = settings.get_string('evcc-user');
        this._password = settings.get_string('evcc-password');
        const selected = new Set(parseSetting(settings, 'evcc-selected-values', []));
        const available = parseSetting(settings, 'evcc-available-values', []);

        this._labels.clear();
        this._topBox.get_children().forEach(child => this._topBox.remove_child(child));
        this.menu.removeAll();

        const logo = new St.Icon({
            icon_name: 'network-server-symbolic',
            style_class: 'system-status-icon',
        });
        const brand = new St.Label({ text: 'evcc', y_align: Clutter.ActorAlign.CENTER });
        this._topBox.add_child(logo);
        this._topBox.add_child(brand);

        available.filter(item => selected.has(item.id)).forEach(item => {
            const label = new St.Label({
                text: `  ${item.name}: ...`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._topBox.add_child(label);
            this._labels.set(item.id, { label, name: item.name });
        });

        const openItem = new PopupMenu.PopupMenuItem('Open evcc web app');
        openItem.connect('activate', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(this._url, null);
            } catch (e) {
                logError(e, 'Could not open evcc web app');
            }
        });
        this.menu.addMenuItem(openItem);

        if (available.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Connect to evcc in Preferences'));
        }
    }

    _refresh() {
        if (!this._url || this._labels.size === 0)
            return;

        try {
            const message = new Soup.Message({
                method: 'GET',
                uri: GLib.Uri.parse(`${this._url}/api/state`, GLib.UriFlags.NONE),
            });
            addAuthorization(message, this._user, this._password);
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.status_code !== 200)
                        throw new Error(`evcc returned HTTP ${message.status_code}`);

                    const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                    const values = new Map(flattenValues(data.result ?? data).map(item => [item.id, item.value]));
                    this._labels.forEach((info, id) => {
                        if (values.has(id))
                            info.label.set_text(`  ${info.name}: ${formatValue(values.get(id))}`);
                    });
                } catch (e) {
                    this._labels.forEach(info => info.label.set_text(`  ${info.name}: unavailable`));
                    logError(e, 'Could not refresh evcc state');
                }
            });
        } catch (e) {
            logError(e, 'Could not request evcc state');
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._session.abort();
        super.destroy();
    }
});

export default class EvccExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new EvccIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._settingsId = this._settings.connect('changed', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._indicator) {
                    this._indicator._rebuild();
                    this._indicator._refresh();
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    disable() {
        if (this._settings && this._settingsId)
            this._settings.disconnect(this._settingsId);
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
        this._settingsId = null;
    }
}
