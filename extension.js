import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
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

function formatValue(value, id) {
    if (typeof value === 'boolean')
        return value ? 'on' : 'off';

    if (typeof value === 'number' && Number.isFinite(value)) {
        const key = id.split('.').at(-1);
        if (/power$/i.test(key))
            return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value / 1000)} kW`;
        if (/(energy)$/i.test(key))
            return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} kWh`;
        if (/share$/i.test(key))
            return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value * 100)}%`;
        if (/(soc|percent|percentage)$/i.test(key))
            return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
        if (/current$/i.test(key))
            return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} A`;
        if (/voltage$/i.test(key))
            return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)} V`;
        if (/(temperature|temp)$/i.test(key))
            return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} °C`;
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    }
    return String(value);
}

function addAuthorization(message, user, password) {
    if (user || password) {
        const bytes = new TextEncoder().encode(`${user}:${password}`);
        message.request_headers.append('Authorization', `Basic ${GLib.base64_encode(bytes)}`);
    }
}

function scheduleIdle(sourceIds, callback) {
    if (!sourceIds)
        return;

    let sourceId = 0;
    sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        sourceIds.delete(sourceId);
        callback();
        return GLib.SOURCE_REMOVE;
    });
    sourceIds.add(sourceId);
}

const EvccIndicator = GObject.registerClass({
    GTypeName: 'EvccIndicator',
}, class EvccIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'evcc', true);
        this._extension = extension;
        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            this._openWebApp();
            return Clutter.EVENT_STOP;
        });
        this._session = new Soup.Session();
        this._labels = new Map();
        this._idleSourceIds = new Set();
        this._webappProcess = null;
        this._webappWindow = null;
        this._webappWindowTitle = null;
        this._windowCreatedId = global.display.connect('window-created', (_display, window) => {
            this._watchWebAppWindow(window);
        });
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

        const logo = new St.Icon({
            icon_name: 'battery-full-charged-symbolic',
            style_class: 'system-status-icon',
        });
        this._topBox.add_child(logo);

        available.filter(item => selected.has(item.id)).forEach(item => {
            const label = new St.Label({
                text: '  ...',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._topBox.add_child(label);
            this._labels.set(item.id, label);
        });

        this._positionWebApp();
    }

    _openWebApp() {
        if (this._webappWindow) {
            this._webappWindow.delete(global.get_current_time());
            return;
        }
        if (this._webappProcess)
            return;

        this._webappWindowTitle = `evcc-webapp-${GLib.uuid_string_random()}`;
        try {
            const helperPath = this._extension.dir.get_child('webapp.js').get_path();
            const process = Gio.Subprocess.new(
                ['gjs', '-m', helperPath],
                Gio.SubprocessFlags.STDIN_PIPE
            );
            this._webappProcess = process;

            const config = JSON.stringify({
                url: this._url,
                user: this._user,
                password: this._password,
                windowTitle: this._webappWindowTitle,
            });
            const stdin = process.get_stdin_pipe();
            stdin.write_all(new TextEncoder().encode(config), null);
            stdin.close(null);

            process.wait_async(null, (subprocess, result) => {
                try {
                    subprocess.wait_finish(result);
                } catch (e) {
                    logError(e, 'Could not wait for evcc web app');
                }
                if (this._webappProcess === subprocess) {
                    this._webappProcess = null;
                    this._webappWindow = null;
                    this._webappWindowTitle = null;
                }
            });
        } catch (e) {
            this._webappProcess = null;
            this._webappWindowTitle = null;
            logError(e, 'Could not launch evcc web app');
        }
    }

    _watchWebAppWindow(window) {
        let titleSignalId = 0;
        const matchWindow = () => {
            if (!this._webappWindowTitle || window.get_title() !== this._webappWindowTitle)
                return;

            this._webappWindow = window;
            if (titleSignalId) {
                window.disconnect(titleSignalId);
                titleSignalId = 0;
            }

            const actor = window.get_compositor_private();
            if (!actor)
                return;

            const positionWhenMapped = () => {
                if (!actor.is_mapped())
                    return;

                actor.disconnect(mappedSignalId);
                scheduleIdle(this._idleSourceIds, () => {
                    this._positionWebApp();
                });
            };
            const mappedSignalId = actor.connect('notify::mapped', positionWhenMapped);
            positionWhenMapped();
        };

        titleSignalId = window.connect('notify::title', matchWindow);
        window.connect('unmanaged', () => {
            if (titleSignalId)
                window.disconnect(titleSignalId);
            if (this._webappWindow === window)
                this._webappWindow = null;
        });
        matchWindow();
    }

    _positionWebApp() {
        if (!this._webappWindow)
            return;

        const [actorX, actorY] = this.get_transformed_position();
        const [actorWidth, actorHeight] = this.get_transformed_size();
        const centerX = actorX + actorWidth / 2;
        const centerY = actorY + actorHeight / 2;
        const monitor = Main.layoutManager.monitors.find(item =>
            centerX >= item.x && centerX < item.x + item.width &&
            centerY >= item.y && centerY < item.y + item.height
        ) ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const frame = this._webappWindow.get_frame_rect();
        if (frame.width <= 0 || frame.height <= 0)
            return;

        const [, panelY] = Main.panel.get_transformed_position();
        const [, panelHeight] = Main.panel.get_transformed_size();
        const width = Math.min(frame.width, monitor.width);
        const height = Math.min(frame.height, monitor.height);
        const x = Math.max(
            monitor.x,
            Math.min(Math.round(centerX - width / 2), monitor.x + monitor.width - width)
        );
        const y = Math.max(
            monitor.y,
            Math.min(Math.round(panelY + panelHeight), monitor.y + monitor.height - height)
        );

        this._webappWindow.move_frame(false, x, y);
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
                    this._labels.forEach((label, id) => {
                        if (values.has(id))
                            label.set_text(`  ${formatValue(values.get(id), id)}`);
                        else
                            label.set_text('  unavailable');
                    });
                } catch (e) {
                    this._labels.forEach(label => label.set_text('  unavailable'));
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
        if (this._idleSourceIds) {
            for (const sourceId of this._idleSourceIds)
                GLib.Source.remove(sourceId);
            this._idleSourceIds = null;
        }
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }
        if (this._webappProcess) {
            this._webappProcess.force_exit();
            this._webappProcess = null;
        }
        this._session.abort();
        super.destroy();
    }
});

export default class EvccExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsIdleSourceIds = new Set();
        this._indicator = new EvccIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._settingsId = this._settings.connect('changed', () => {
            scheduleIdle(this._settingsIdleSourceIds, () => {
                if (this._indicator) {
                    this._indicator._rebuild();
                    this._indicator._refresh();
                }
            });
        });
    }

    disable() {
        if (this._settings && this._settingsId)
            this._settings.disconnect(this._settingsId);
        if (this._settingsIdleSourceIds) {
            for (const sourceId of this._settingsIdleSourceIds)
                GLib.Source.remove(sourceId);
            this._settingsIdleSourceIds = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
        this._settingsId = null;
    }
}
