import browser from 'webextension-polyfill'
import { registerMessageHandler } from '../message-handlers'
import { getCurrentTab } from '../utils'
import { getExtensionURL } from '../wrapper'
import { getDomain, parse } from 'tldts'
import { sendPixelRequest } from '../pixels'

/**
 * @typedef {object} BurnConfig
 * @property {boolean} closeTabs
 * @property {boolean} clearHistory
 * @property {number} [since]
 * @property {string[]} [origins]
 */

/**
 * @typedef {import('../tab-manager.js')} TabManager
 * @typedef {import('../settings.js')} Settings
 */

const tldtsOptions = { allowPrivateDomains: true }

export default class FireButton {
    /**
     * @param {{
     *  settings: Settings;
     *  tabManager: TabManager;
     * }}
     */
    constructor ({ settings, tabManager }) {
        this.featureName = 'FireButton'
        this.settings = settings
        this.tabManager = tabManager
        registerMessageHandler('doBurn', this.burn.bind(this))
        registerMessageHandler('getBurnOptions', this.getBurnOptions.bind(this))
        registerMessageHandler('fireAnimationComplete', this.onFireAnimationComplete.bind(this))
        registerMessageHandler('setBurnDefaultOption', (msg) => {
            this.settings.updateSetting('fireButtonDefaultOption', msg.defaultOption)
        })
    }

    getDefaultSettings () {
        return {
            closeTabs: this.settings.getSetting('fireButtonTabClearEnabled'),
            clearHistory: this.settings.getSetting('fireButtonHistoryEnabled'),
            selectedOption: this.settings.getSetting('fireButtonDefaultOption') || 'CurrentSite',
            since: undefined
        }
    }

    /**
     * @param {Partial<BurnConfig>} options
     * @returns {Promise<boolean>}
     */
    async burn (options) {
        /** @type {BurnConfig} config */
        const config = Object.assign(this.getDefaultSettings(), options)

        console.log('🔥', config)
        try {
            await this.clearTabs(config.closeTabs, config.origins)
            // 1/ Clear downloads and history
            const clearing = []
            if (!config.origins || config.origins.length === 0) {
                clearing.push(chrome.browsingData.remove({
                    since: config.since
                }, {
                    downloads: true,
                    history: config.clearHistory
                }))
            }
            // TODO: handle clearing downloads and history for specific origins

            // 2/ Clear cookies, except on SERP
            const cookieOptions = {
                since: config.since
            }
            if (config.origins) {
                cookieOptions.origins = config.origins
            } else {
                cookieOptions.excludeOrigins = ['https://duckduckgo.com']
            }
            clearing.push(chrome.browsingData.remove(cookieOptions, {
                cookies: true,
                localStorage: true
            }))
            // 3/ Clear origin-keyed storage
            clearing.push(chrome.browsingData.remove({
                origins: config.origins,
                since: config.since
            }, {
                appcache: true,
                cache: true,
                cacheStorage: true,
                indexedDB: true,
                fileSystems: true,
                serviceWorkers: true,
                webSQL: true
            }))
            const results = await Promise.all(clearing)
            console.log('🔥 result', results)
            sendPixelRequest('e_firebutton_click', {
                atb: this.settings.getSetting('atb')
            })
            return true
        } catch (e) {
            console.error('🔥 error', e)
            return false
        }
    }

    /**
     * @param {boolean} closeTabs If true, tabs are also closed
     * @param {string[]} [origins] Only close tabs for these origins
     */
    async clearTabs (closeTabs = true, origins) {
        // gather all non-pinned tabs
        const openTabs = (await browser.tabs.query({
            pinned: false
        })).filter(tabMatchesHostFilter(origins))
        const removeTabIds = openTabs.map(t => t.id || 0)
        // clear adclick attribution data
        removeTabIds.forEach((tabId) => {
            const tab = this.tabManager.tabContainer[tabId]
            if (tab && tab.adClick !== null) {
                tab.adClick = null
            }
        })
        // create a new tab which will be open after the burn
        await this.showBurnAnimation()
        if (closeTabs) {
            // remove the rest of the open tabs
            await browser.tabs.remove(removeTabIds)
        }
    }

    async showBurnAnimation () {
        await browser.tabs.create({
            active: true,
            url: getExtensionURL('/html/fire.html')
        })
    }

    /**
     * Get options to display in the burn modal
     * @returns {Promise<import('@duckduckgo/privacy-dashboard/schema/__generated__/schema.types').FireButtonData>}
     */
    async getBurnOptions () {
        const ONE_HOUR = 60 * 60 * 1000
        const [currentTab, allTabs, allCookies] = await Promise.all([
            getCurrentTab(),
            browser.tabs.query({}),
            browser.cookies.getAll({})
        ])
        const openTabs = allTabs.filter(t => !t.pinned).length
        const cookies = allCookies.reduce((sites, curr) => {
            sites.add(getDomain(curr.domain, tldtsOptions))
            return sites
        }, new Set()).size
        const pinnedTabs = allTabs.filter(t => t.pinned)
        // Apply defaults for history and tab clearing
        const { closeTabs, clearHistory, selectedOption } = this.getDefaultSettings()

        const defaultStats = {
            openTabs: closeTabs ? openTabs : 0,
            cookies,
            pinnedTabs: closeTabs ? pinnedTabs.length : 0,
            clearHistory
        }

        /** @type {import('@duckduckgo/privacy-dashboard/schema/__generated__/schema.types').FireOption[]} */
        const options = []
        const currentTabUrl = currentTab?.url || ''
        // only show the current site option if this an origin we can clear
        if (currentTabUrl.startsWith('http:') || currentTabUrl.startsWith('https:')) {
            const origins = getOriginsForUrl(currentTabUrl)
            const tabsMatchingOrigin = allTabs.filter(tabMatchesHostFilter(origins)).length
            const pinnedMatchingOrigin = pinnedTabs.filter(tabMatchesHostFilter(origins)).length
            options.push({
                name: 'CurrentSite',
                options: {
                    origins
                },
                descriptionStats: {
                    ...defaultStats,
                    openTabs: closeTabs ? tabsMatchingOrigin : 0,
                    pinnedTabs: closeTabs ? pinnedMatchingOrigin : 0,
                    cookies: 1,
                    duration: 'all',
                    site: getDomain(origins[0], tldtsOptions) || ''
                }
            })
        }

        options.push({
            name: 'LastHour',
            options: {
                since: Date.now() - ONE_HOUR
            },
            descriptionStats: {
                ...defaultStats,
                duration: 'hour'
            }
        })
        options.push({
            name: 'Last24Hour',
            options: {
                since: Date.now() - (24 * ONE_HOUR)
            },
            descriptionStats: {
                ...defaultStats,
                duration: 'day'
            }
        })
        options.push({
            name: 'Last7days',
            options: {
                since: Date.now() - (7 * 24 * ONE_HOUR)
            },
            descriptionStats: {
                ...defaultStats,
                duration: 'week'
            }
        })
        options.push({
            name: 'Last4Weeks',
            options: {
                since: Date.now() - (4 * 7 * 24 * ONE_HOUR)
            },
            descriptionStats: {
                ...defaultStats,
                duration: 'month'
            }
        })
        options.push({
            name: 'AllTime',
            options: {},
            descriptionStats: {
                ...defaultStats,
                duration: 'all'
            }
        })

        // mark selected site
        options.forEach((option) => {
            if (option.name === selectedOption) {
                option.selected = true
            }
        })

        return {
            options
        }
    }

    async onFireAnimationComplete (msg, sender) {
        const fireTabId = sender.tab.id
        chrome.tabs.update(fireTabId, {
            url: 'chrome://newtab'
        })
    }
}

export function getOriginsForUrl (url) {
    const origins = []
    const { subdomain, domain } = parse(url, { allowPrivateDomains: true })
    origins.push(`https://${domain}`)
    origins.push(`http://${domain}`)
    if (subdomain) {
        const subParts = subdomain.split('.').reverse()
        for (let i = 1; i <= subParts.length; i++) {
            const sd = subParts.slice(0, i).reverse().join('.') + '.' + domain
            origins.push(`https://${sd}`)
            origins.push(`http://${sd}`)
        }
    }
    return origins
}

/**
 * @param {string[]} [origins]
 * @returns {(tab: { url?: string | undefined }) => boolean}
 */
export function tabMatchesHostFilter (origins) {
    if (!origins) {
        return () => true
    }
    const etldPlusOnes = new Set()
    origins.forEach(o => etldPlusOnes.add(getDomain(o, tldtsOptions)))
    return tab => !!tab.url && etldPlusOnes.has(getDomain(tab.url, tldtsOptions))
}
