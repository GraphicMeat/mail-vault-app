import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
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

const LOCATION_OPTIONS = [
  { id: 'all', label: 'All', icon: Layers },
  { id: 'server', label: 'Server', icon: Cloud },
  { id: 'local', label: 'Local', icon: HardDrive },
];

export function SearchBar() {
  const {
    searchQuery,
    searchFilters,
    searchActive,
    isSearching,
    searchResults,
    setSearchQuery,
    setSearchFilters,
    performSearch,
    clearSearch,
    mailboxes,
    activeMailbox
  } = useMailStore();

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
      case 'sender': return `From: ${filter.value}`;
      case 'folder': return `In: ${filter.value}`;
      case 'dateRange': return `Date: ${filter.value}`;
      case 'hasAttachments': return 'Has attachments';
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
            placeholder="Search emails..."
            className="w-full pl-9 pr-20 py-2 bg-mail-bg border border-mail-border rounded-lg
                      text-mail-text placeholder-mail-text-muted text-sm
                      focus:border-mail-accent focus:outline-none transition-colors"
          />

          {/* Location selector inside input */}
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {(localQuery || searchActive) && (
              <button
                type="button"
                onClick={handleClear}
                className="p-1 hover:bg-mail-border rounded transition-colors"
              >
                <X size={14} className="text-mail-text-muted" />
              </button>
            )}

            <select
              value={searchFilters.location}
              onChange={(e) => handleFilterChange('location', e.target.value)}
              className="appearance-none bg-mail-surface border border-mail-border rounded
                        px-2 py-0.5 text-xs text-mail-text cursor-pointer
                        focus:outline-none focus:border-mail-accent"
            >
              {LOCATION_OPTIONS.map(opt => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Filter button */}
        <div className="relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={`p-2 rounded-lg border transition-colors ${
              showFilters || searchFilters.sender || searchFilters.dateFrom || searchFilters.dateTo || searchFilters.hasAttachments
                ? 'bg-mail-accent/10 border-mail-accent text-mail-accent'
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
                          rounded-xl shadow-xl z-[100] p-4"
              >
                <h4 className="font-medium text-mail-text mb-3 flex items-center gap-2">
                  <Filter size={14} />
                  Search Filters
                </h4>

                <div className="space-y-3">
                  {/* Folder */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 flex items-center gap-1">
                      <Folder size={12} />
                      Folder
                    </label>
                    <select
                      value={searchFilters.folder}
                      onChange={(e) => handleFilterChange('folder', e.target.value)}
                      className="w-full px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg
                                text-sm text-mail-text focus:border-mail-accent focus:outline-none"
                    >
                      <option value="current">Current folder ({activeMailbox})</option>
                      <option value="all">All folders</option>
                      {mailboxes
                        .filter(mb => mb.path !== activeMailbox)
                        .map(mb => (
                          <option key={mb.path} value={mb.path}>{mb.name}</option>
                        ))
                      }
                    </select>
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
                      placeholder="Email or name..."
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
                        Date range
                      </label>
                      {(searchFilters.dateFrom || searchFilters.dateTo) && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchFilters({ dateFrom: null, dateTo: null });
                          }}
                          className="text-xs text-mail-text-muted hover:text-mail-accent transition-colors"
                        >
                          Reset
                        </button>
                      )}
                    </div>

                    {/* Quick presets */}
                    <div className="flex gap-1 mb-2">
                      {[
                        { label: 'Week', days: 7 },
                        { label: 'Month', days: 30 },
                        { label: '3 Months', days: 90 },
                        { label: 'Year', days: 365 },
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
                                ? 'bg-mail-accent text-white'
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
                      <span>From</span>
                      <span>To</span>
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
                    <span className="text-sm text-mail-text">Has attachments</span>
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
                    Clear all filters
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Search button */}
        <button
          type="submit"
          className="px-4 py-2 bg-mail-accent hover:bg-mail-accent-hover text-white
                    font-medium rounded-lg text-sm transition-colors"
        >
          Search
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
                      rounded-xl shadow-xl z-[100] p-3 max-h-80 overflow-y-auto"
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
                                  rounded-lg text-xs text-mail-accent hover:bg-mail-accent/20 transition-colors"
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
                    Recent searches
                  </h4>
                  <button
                    onClick={clearSearchHistory}
                    className="text-xs text-mail-text-muted hover:text-mail-danger transition-colors"
                  >
                    Clear all
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
              Searching local cache, saved emails, and server...
            </span>
          ) : (
            <>
              Found <span className="font-medium text-mail-text">{searchResults.length}</span> results
              {searchFilters.folder === 'current' && ` in ${activeMailbox}`}
              {searchFilters.folder === 'all' && ' in all folders'}
              {searchResults.length > 0 && (
                <span className="ml-2 text-[10px]">
                  ({searchResults.filter(e => e.source === 'local' || e.source === 'local-only').length} local,
                  {' '}{searchResults.filter(e => e.source === 'server' || e.source === 'server-search').length} server)
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
