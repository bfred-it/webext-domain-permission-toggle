import chromeP from 'webext-polyfill-kinda';
import {patternToRegex} from 'webext-patterns';
import {isBackgroundPage} from 'webext-detect-page';
import {getManifestPermissionsSync} from 'webext-additional-permissions';

const isFirefox = typeof navigator === 'object' && navigator.userAgent.includes('Firefox/');

const contextMenuId = 'webext-domain-permission-toggle:add-permission';
let globalOptions: Options;

interface Options {
	/**
	 * The title of the action in the context menu.
	 */
	title?: string;

	/**
	 * If the user accepts the new permission, they will be asked to reload the current tab.
	 * Set a `string` to customize the message and `false` to avoid the reload and its request.
	 */
	reloadOnSuccess?: string | boolean;
}

async function executeCode(
	tabId: number,
	function_: string | ((...args: any[]) => void),
	...args: any[]
): Promise<any[]> {
	return chromeP.tabs.executeScript(tabId, {
		code: `(${function_.toString()})(...${JSON.stringify(args)})`
	});
}

async function isOriginPermanentlyAllowed(origin: string): Promise<boolean> {
	return chromeP.permissions.contains({
		origins: [origin + '/*']
	});
}

async function getTabUrl(tabId: number): Promise<string | undefined> {
	// In Firefox, inexplicably, `Tab` does not have the URL property, even if you have access to the origin. They *require* the `tabs` permission for this.
	if (isFirefox) {
		const [url] = await executeCode(tabId, () => location.href);
		return url;
	}

	const tab = await chromeP.tabs.get(tabId);
	return tab.url;
}

async function updateItem(url?: string): Promise<void> {
	const settings = {
		checked: false,
		enabled: true
	};

	// No URL means no activeTab, no manifest permission, no granted permission, or no permission possible (chrome://)
	if (url) {
		const origin = new URL(url).origin;
		// Manifest permissions can't be removed; this disables the toggle on those domains
		const manifestPermissions = getManifestPermissionsSync();
		const isDefault = patternToRegex(...manifestPermissions.origins).test(origin);
		settings.enabled = !isDefault;

		// We might have temporary permission as part of `activeTab`, so it needs to be properly checked
		settings.checked = isDefault || await isOriginPermanentlyAllowed(origin);
	}

	chrome.contextMenus.update(contextMenuId, settings);
}

async function togglePermission(tab: chrome.tabs.Tab, toggle: boolean): Promise<void> {
	// Don't use non-ASCII characters because Safari breaks the encoding in executeScript.code
	const safariError = 'The browser didn\'t supply any information about the active tab.';
	if (!tab.url && toggle) {
		throw new Error(`Please try again. ${safariError}`);
	}

	if (!tab.url && !toggle) {
		throw new Error(`Couldn't disable the extension on the current tab. ${safariError}`);
	}

	// TODO: Ensure that URL is in `optional_permissions`
	const permissionData = {
		origins: [
			new URL(tab.url!).origin + '/*'
		]
	};

	if (!toggle) {
		void chromeP.permissions.remove(permissionData);
		return;
	}

	const userAccepted = await chromeP.permissions.request(permissionData);
	if (!userAccepted) {
		chrome.contextMenus.update(contextMenuId, {
			checked: false
		});
		return;
	}

	if (globalOptions.reloadOnSuccess) {
		void executeCode(tab.id!, (message: string) => {
			if (confirm(message)) {
				location.reload();
			}
		}, globalOptions.reloadOnSuccess);
	}
}

async function handleTabActivated({tabId}: chrome.tabs.TabActiveInfo): Promise<void> {
	void updateItem(await getTabUrl(tabId).catch(() => ''));
}

async function handleClick(
	{checked, menuItemId}: chrome.contextMenus.OnClickData,
	tab?: chrome.tabs.Tab
): Promise<void> {
	if (menuItemId !== contextMenuId) {
		return;
	}

	try {
		await togglePermission(tab!, checked!);
	} catch (error) {
		if (tab?.id) {
			try {
				await executeCode(
					tab.id,
					'alert' /* Can't pass a raw native function */,

					// https://github.com/mozilla/webextension-polyfill/pull/258
					String(error instanceof Error ? error : new Error(error.message))
				);
			} catch {
				alert(error); // One last attempt
			}

			void updateItem();
		}

		throw error;
	}
}

/**
 * Adds an item to the browser action icon's context menu.
 * The user can access this menu by right clicking the icon. If your extension doesn't have any action or
 * popup assigned to the icon, it will also appear with a left click.
 *
 * @param options {Options}
 */
export default function addDomainPermissionToggle(options?: Options): void {
	if (!isBackgroundPage()) {
		throw new Error('webext-domain-permission-toggle can only be called from a background page');
	}

	if (globalOptions) {
		throw new Error('webext-domain-permission-toggle can only be initialized once');
	}

	const {name, optional_permissions} = chrome.runtime.getManifest();
	globalOptions = {
		title: `Enable ${name} on this domain`,
		reloadOnSuccess: `Do you want to reload this page to apply ${name}?`,
		...options
	};

	if (!chrome.contextMenus) {
		throw new Error('webext-domain-permission-toggle requires the `contextMenu` permission');
	}

	const optionalHosts = optional_permissions?.filter(permission => /<all_urls>|\*/.test(permission));
	if (!optionalHosts || optionalHosts.length === 0) {
		throw new TypeError('webext-domain-permission-toggle some wildcard hosts to be specified in `optional_permissions`');
	}

	chrome.contextMenus.remove(contextMenuId, () => chrome.runtime.lastError);
	chrome.contextMenus.create({
		id: contextMenuId,
		type: 'checkbox',
		checked: false,
		title: globalOptions.title,
		contexts: ['page_action', 'browser_action'],

		// Note: This is completely ignored by Chrome and Safari. Great. #14
		documentUrlPatterns: optionalHosts
	});

	chrome.contextMenus.onClicked.addListener(handleClick);
	chrome.tabs.onActivated.addListener(handleTabActivated);
	chrome.tabs.onUpdated.addListener(async (tabId, {status}, {url, active}) => {
		if (active && status === 'complete') {
			void updateItem(url ?? await getTabUrl(tabId).catch(() => ''));
		}
	});
}
