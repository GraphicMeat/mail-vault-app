import { Button } from './ui/Button';
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useSearchStore } from '../stores/searchStore';
import { useSettingsStore } from '../stores/settingsStore';
import { flattenMailboxes } from '../stores/slices/unifiedHelpers';
import { SUBTREE_PREFIX } from '../services/workflows/mailboxTree';
import { decodeImapUtf7 } from '../utils/imapUtf7';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  X,
  Filter,
  ChevronDown,
  Clock,
  HardDrive,
  Cloud,
  Layers,
  Calendar,
  User,
  Paperclip,
  Folder,
  Trash2,
  TrendingUp
} from 'lucide-react';
import { t, useT  } from '../i18n/index.js';
import { T } from '../i18n/T.jsx';

const LOCATION_OPTIONS = [
  { id: 'all', labelKey: 'search.location.all', icon: Layers },
  { id: 'server', labelKey: 'search.location.server', icon: Cloud },
  // Same rename as the sidebar's view filter: the place is called the vault
  // everywhere else in the product, so this control names it too.
  { id: 'local', labelKey: 'search.location.vault', icon: HardDrive },
];

export function SearchBar() {
  const t = useT();
  const searchQuery = useSearchStore(s => s.searchQuery);
  const searchFilters = useSearchStore(s => s.searchFilters);
  const searchActive = useSearchStore(s => s.searchActive);
  const isSearching = useSearchStore(s => s.isSearching);
  const searchProgress = useSearchStore(s => s.searchProgress);
  const searchResults = useSearchStore(s => s.searchResults);
  const setSearchQuery = useSearchStore(s => s.setSearchQuery);
  const setSearchFilters = useSearchStore(s => s.setSearchFilters);
  const performSearch = useSearchStore(s => s.performSearch);
  const clearSearch = useSearchStore(s => s.clearSearch);
  const mailboxes = useAccountStore(s => s.mailboxes);
  const activeMailbox = useAccountStore(s => s.activeMailbox);

  const {
    searchHistory,
    removeSearchFromHistory,
    clearSearchHistory,
    addFilterUsage,
    getPopularFilters,
    filterHistoryPeriodDays
  } = useSettingsStore();

  const [showFilters, setShowFilters] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const inputRef = useRef(null);
  const filterRef = useRef(null);
  const historyRef = useRef(null);

  // Get popular filters
  const popularFilters = useMemo(() => getPopularFilters(), [getPopularFilters]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (filterRef.current && !filterRef.current.contains(e.target)) {
        setShowFilters(false);
      }
      if (historyRef.current && !historyRef.current.contains(e.target) &&
          !inputRef.current?.contains(e.target)) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (e) => {
    e?.preventDefault();
    setSearchQuery(localQuery);

    // Track filter usage
    if (searchFilters.sender) {
      addFilterUsage('sender', searchFilters.sender);
    }
    if (searchFilters.folder && searchFilters.folder !== 'current') {
      addFilterUsage('folder', searchFilters.folder);
    }
    if (searchFilters.dateFrom || searchFilters.dateTo) {
      const dateRange = `${searchFilters.dateFrom || 'any'} to ${searchFilters.dateTo || 'any'}`;
      addFilterUsage('dateRange', dateRange);
    }
    if (searchFilters.hasAttachments) {
      addFilterUsage('hasAttachments', 'true');
    }

    setTimeout(() => performSearch(), 0);
    setShowHistory(false);
  };

  const handleHistorySelect = (query) => {
    setLocalQuery(query);
    setSearchQuery(query);
    setShowHistory(false);
    setTimeout(() => performSearch(), 0);
  };

  const handleClear = () => {
    setLocalQuery('');
    clearSearch();
    setShowHistory(false);
    setShowFilters(false);
  };

  // The folder filter carries its own scope: `sub:X` means X and everything
  // filed under it. The select shows the folder either way; the checkbox is
  // what the prefix means.
  const scopedToBranch = String(searchFilters.folder).startsWith(SUBTREE_PREFIX);
  const pickedFolder = scopedToBranch
    ? String(searchFilters.folder).slice(SUBTREE_PREFIX.length)
    : searchFilters.folder;
  const branchable = pickedFolder !== 'all';

  const handleFilterChange = (key, value) => {
    setSearchFilters({ [key]: value });
    // Auto-search when filters change if there's an active search
    if (searchActive || localQuery.trim()) {
      setTimeout(() => performSearch(), 0);
    }
  };

  const applyPopularFilter = (filter) => {
    switch (filter.type) {
      case 'sender':
        setSearchFilters({ sender: filter.value });
        break;
      case 'folder':
        setSearchFilters({ folder: filter.value });
        break;
      case 'dateRange':
        const [from, to] = filter.value.split(' to ');
        setSearchFilters({
          dateFrom: from === 'any' ? null : from,
          dateTo: to === 'any' ? null : to
        });
        break;
      case 'hasAttachments':
        setSearchFilters({ hasAttachments: true });
        break;
    }
    setShowHistory(false);
    setTimeout(() => performSearch(), 0);
  };

  const getFilterIcon = (type) => {
    switch (type) {
      case 'sender': return User;
      case 'folder': return Folder;
      case 'dateRange': return Calendar;
      case 'hasAttachments': return Paperclip;
      default: return Filter;
    }
  };

  const getFilterLabel = (filter) => {
    switch (filter.type) {
      case 'sender': return t('search.from', { filter: filter.value });
      case 'folder': return t('search.in', { filter: filter.value });
      case 'dateRange': return t('search.date', { filter: filter.value });
      case 'hasAttachments': return t('chat.topics.hasAttachments');
      default: return filter.value;
    }
  };

  const LocationIcon = LOCATION_OPTIONS.find(o => o.id === searchFilters.location)?.icon || Layers;

  return (
    <div className="relative">
      <form onSubmit={handleSearch} className="flex items-center gap-2">
        {/* Search Input */}
        <div className="relative flex-1">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-mail-text-muted">
            {isSearching ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
              >
                <Search size={16} />
              </motion.div>
            ) : (
              <Search size={16} />
            )}
          </div>

          <input
            ref={inputRef}
            type="text"
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            onFocus={() => searchHistory.length > 0 && setShowHistory(true)}
            placeholder={t('search.searchEmails')}
            className="w-full pl-9 pr-20 py-2 bg-mail-bg border border-mail-border rounded-lg
                      text-mail-text placeholder-mail-text-muted text-sm
                      focus:border-mail-accent focus:outline-none transition-colors"
          />

          {/* Location selector inside input */}
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {(localQuery || searchActive) && (
              <Button variant="ghost" icon size="xs" className="hover:bg-mail-border"
                type="button"
                onClick={handleClear}
              >
                <X size={14} className="text-mail-text-muted" />
              </Button>
            )}

            <select
              value={searchFilters.location}
              onChange={(e) => handleFilterChange('location', e.target.value)}
              className="appearance-none bg-mail-surface border border-mail-border rounded
                        px-2 py-0.5 text-xs text-mail-text cursor-pointer
                        focus:outline-none focus:border-mail-accent"
            >
              {LOCATION_OPTIONS.map(opt => (
                <option key={opt.id} value={opt.id}>{t(opt.labelKey)}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Filter button */}
        <div className="relative" ref={filterRef}>
          <button
            type="button"
            data-testid="search-filters-toggle"
            onClick={() => setShowFilters(!showFilters)}
            className={`p-2 rounded-lg border transition-colors ${
              showFilters || searchFilters.sender || searchFilters.dateFrom || searchFilters.dateTo || searchFilters.hasAttachments
                ? 'bg-mail-accent/10 border-mail-accent text-mail-accent-text'
                : 'bg-mail-bg border-mail-border text-mail-text-muted hover:text-mail-text hover:border-mail-text-muted'
            }`}
          >
            <Filter size={16} />
          </button>

          {/* Filter dropdown */}
          <AnimatePresence>
            {showFilters && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                className="absolute right-0 top-full mt-2 w-72 bg-mail-surface border border-mail-border
                          rounded-xl z-[100] p-4"
              >
                <h4 className="font-medium text-mail-text mb-3 flex items-center gap-2">
                  <Filter size={14} />
                  {t('search.searchFilters')}
                </h4>

                <div className="space-y-3">
                  {/* Folder */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 flex items-center gap-1">
                      <Folder size={12} />
                      {t('common.folder')}
                    </label>
                    <select
                      data-testid="search-folder-scope"
                      value={pickedFolder}
                      onChange={(e) => handleFilterChange('folder',
                        scopedToBranch && e.target.value !== 'all'
                          ? `${SUBTREE_PREFIX}${e.target.value}`
                          : e.target.value)}
                      className="w-full px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg
                                text-sm text-mail-text focus:border-mail-accent focus:outline-none"
                    >
                      <option value="current">{t('search.currentFolderNamed', { folder: decodeImapUtf7(activeMailbox) })}</option>
                      <option value="all">{t('search.allFolders')}</option>
                      {/* Flattened: a nested folder is a search target like any
                          other, and the top-level list left 50 of bson73's 59
                          unpickable. */}
                      {flattenMailboxes(mailboxes)
                        .filter(mb => !mb.noselect && mb.path !== activeMailbox)
                        .map(mb => (
                          <option key={mb.path} value={mb.path}>{decodeImapUtf7(mb.path)}</option>
                        ))
                      }
                    </select>
                    <label className="mt-1.5 flex items-center gap-1.5 text-xs text-mail-text-muted
                                      cursor-pointer has-[:disabled]:cursor-default has-[:disabled]:opacity-50">
                      <input
                        type="checkbox"
                        data-testid="search-include-subfolders"
                        checked={branchable && scopedToBranch}
                        disabled={!branchable}
                        onChange={(e) => handleFilterChange('folder',
                          e.target.checked ? `${SUBTREE_PREFIX}${pickedFolder}` : pickedFolder)}
                        className="accent-mail-accent"
                      />
                      {t('search.includeSubfolders')}
                    </label>
                  </div>

                  {/* Sender */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 flex items-center gap-1">
                      <User size={12} />
                      From (sender)
                    </label>
                    <input
                      type="text"
                      value={searchFilters.sender}
                      onChange={(e) => handleFilterChange('sender', e.target.value)}
                      placeholder={t('search.emailName')}
                      className="w-full px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg
                                text-sm text-mail-text placeholder-mail-text-muted
                                focus:border-mail-accent focus:outline-none"
                    />
                  </div>

                  {/* Date range */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-mail-text-muted flex items-center gap-1">
                        <Calendar size={12} />
                        {t('search.dateRange')}
                      </label>
                      {(searchFilters.dateFrom || searchFilters.dateTo) && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchFilters({ dateFrom: null, dateTo: null });
                          }}
                          className="text-xs text-mail-text-muted hover:text-mail-accent-text transition-colors"
                        >
                          {t('common.reset')}
                        </button>
                      )}
                    </div>

                    {/* Quick presets */}
                    <div className="flex gap-1 mb-2">
                      {[
                        { label: t('search.week'), days: 7 },
                        { label: t('search.month'), days: 30 },
                        { label: '3 Months', days: 90 },
                        { label: t('search.year'), days: 365 },
                      ].map(preset => {
                        const fromDate = new Date();
                        fromDate.setDate(fromDate.getDate() - preset.days);
                        const fromStr = fromDate.toISOString().split('T')[0];
                        const toStr = new Date().toISOString().split('T')[0];
                        const isActive = searchFilters.dateFrom === fromStr && searchFilters.dateTo === toStr;
                        return (
                          <button
                            key={preset.days}
                            type="button"
                            onClick={() => {
                              setSearchFilters({ dateFrom: fromStr, dateTo: toStr });
                            }}
                            className={`flex-1 px-1.5 py-1 text-[10px] rounded transition-colors ${
                              isActive
                                ? 'bg-mail-accent-fill text-white'
                                : 'bg-mail-bg border border-mail-border text-mail-text-muted hover:border-mail-accent hover:text-mail-text'
                            }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="relative">
                        <input
                          type="date"
                          value={searchFilters.dateFrom || ''}
                          max={searchFilters.dateTo || new Date().toISOString().split('T')[0]}
                          onChange={(e) => handleFilterChange('dateFrom', e.target.value || null)}
                          className="w-full px-2 py-1.5 bg-mail-bg border border-mail-border rounded-lg
                                    text-sm text-mail-text focus:border-mail-accent focus:outline-none"
                        />
                        {searchFilters.dateFrom && (
                          <button
                            type="button"
                            onClick={() => handleFilterChange('dateFrom', null)}
                            className="absolute right-7 top-1/2 -translate-y-1/2 p-0.5 hover:bg-mail-border rounded"
                          >
                            <X size={12} className="text-mail-text-muted" />
                          </button>
                        )}
                      </div>
                      <div className="relative">
                        <input
                          type="date"
                          value={searchFilters.dateTo || ''}
                          min={searchFilters.dateFrom || undefined}
                          max={new Date().toISOString().split('T')[0]}
                          onChange={(e) => handleFilterChange('dateTo', e.target.value || null)}
                          className="w-full px-2 py-1.5 bg-mail-bg border border-mail-border rounded-lg
                                    text-sm text-mail-text focus:border-mail-accent focus:outline-none"
                        />
                        {searchFilters.dateTo && (
                          <button
                            type="button"
                            onClick={() => handleFilterChange('dateTo', null)}
                            className="absolute right-7 top-1/2 -translate-y-1/2 p-0.5 hover:bg-mail-border rounded"
                          >
                            <X size={12} className="text-mail-text-muted" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between mt-1 text-[10px] text-mail-text-muted">
                      <span>{t('common.from')}</span>
                      <span>{t('common.to')}</span>
                    </div>
                  </div>

                  {/* Has attachments */}
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={searchFilters.hasAttachments}
                      onChange={(e) => handleFilterChange('hasAttachments', e.target.checked)}
                      className="custom-checkbox"
                    />
                    <Paperclip size={12} className="text-mail-text-muted" />
                    <span className="text-sm text-mail-text">{t('search.hasAttachments')}</span>
                  </label>

                  {/* Clear filters */}
                  <button
                    type="button"
                    onClick={() => {
                      setSearchFilters({
                        location: 'all',
                        folder: 'current',
                        sender: '',
                        dateFrom: null,
                        dateTo: null,
                        hasAttachments: false,
                      });
                    }}
                    className="w-full mt-2 px-3 py-1.5 text-sm text-mail-text-muted
                              hover:text-mail-text hover:bg-mail-bg rounded-lg transition-colors"
                  >
                    {t('search.clearAllFilters')}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Search button */}
        <button
          type="submit"
          className="px-4 py-2 bg-mail-accent-fill hover:bg-mail-accent-hover text-white
                    font-medium rounded-lg text-sm transition-colors"
        >
          {t('search.search')}
        </button>
      </form>

      {/* Search history and popular filters dropdown */}
      <AnimatePresence>
        {showHistory && (searchHistory.length > 0 || popularFilters.length > 0) && (
          <motion.div
            ref={historyRef}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute left-0 right-24 top-full mt-2 bg-mail-surface border border-mail-border
                      rounded-xl z-[100] p-3 max-h-80 overflow-y-auto"
          >
            {/* Popular filters */}
            {popularFilters.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-medium text-mail-text-muted flex items-center gap-1">
                    <TrendingUp size={12} />
                    Popular filters (last {filterHistoryPeriodDays} days)
                  </h4>
                </div>
                <div className="flex flex-wrap gap-2">
                  {popularFilters.map((filter, idx) => {
                    const Icon = getFilterIcon(filter.type);
                    return (
                      <button
                        key={idx}
                        onClick={() => applyPopularFilter(filter)}
                        className="flex items-center gap-1.5 px-2 py-1 bg-mail-accent/10 border border-mail-accent/20
                                  rounded-lg text-xs text-mail-accent-text hover:bg-mail-accent/20 transition-colors"
                      >
                        <Icon size={12} />
                        <span className="max-w-[120px] truncate">{getFilterLabel(filter)}</span>
                        <span className="text-[10px] opacity-70">({filter.count})</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Recent searches */}
            {searchHistory.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-medium text-mail-text-muted flex items-center gap-1">
                    <Clock size={12} />
                    {t('search.recentSearches')}
                  </h4>
                  <button
                    onClick={clearSearchHistory}
                    className="text-xs text-mail-text-muted hover:text-mail-danger transition-colors"
                  >
                    {t('search.clearAll')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {searchHistory.map((query, idx) => (
                    <div
                      key={idx}
                      className="group flex items-center gap-1 px-2 py-1 bg-mail-bg border border-mail-border
                                rounded-lg text-sm text-mail-text hover:border-mail-accent cursor-pointer transition-colors"
                    >
                      <span
                        onClick={() => handleHistorySelect(query)}
                        className="max-w-[150px] truncate"
                      >
                        {query}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeSearchFromHistory(query);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-mail-border rounded transition-all"
                      >
                        <X size={12} className="text-mail-text-muted" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search results indicator */}
      {searchActive && (
        <div className="mt-2 text-xs text-mail-text-muted">
          {isSearching ? (
            <span className="flex items-center gap-2">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
              >
                <Search size={12} />
              </motion.div>
              {searchProgress
                ? t('search.searchingServerFolder', { searchProgress: searchProgress.done, searchProgress2: searchProgress.total })
                : t('search.searchingLocalCacheArchivedEmails')}
            </span>
          ) : (
            <>
              <T k="search.foundResults" vars={{ count: searchResults.length }}
                 parts={[(s) => <span className="font-medium text-mail-text">{s}</span>]} />
              {!scopedToBranch && searchFilters.folder === 'current' && t('search.inFolder', { folder: decodeImapUtf7(activeMailbox) })}
              {!scopedToBranch && searchFilters.folder === 'all' && t('search.inAllFolders')}
              {/* A branch count read as one folder's is the same lie the
                  INBOX-only "all folders" search used to tell. */}
              {scopedToBranch && t('search.inFolderAndSubfolders', {
                folder: decodeImapUtf7(pickedFolder === 'current' ? activeMailbox : pickedFolder),
              })}
              {searchResults.length > 0 && (
                <span className="ml-2 text-[10px]">
                  {t('search.localServerCounts', { local: searchResults.filter(e => e.source === 'local' || e.source === 'local-only').length, server: searchResults.filter(e => e.source === 'server' || e.source === 'server-search').length })}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
