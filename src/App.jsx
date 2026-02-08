import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import TimerDisplay from './components/TimerDisplay'
import Controls from './components/Controls'
import { io } from 'socket.io-client';

// Connect to the server.
// In PROD (PWA/Exe): Server serves the app, so we connect to the same host/port (relative).
// In DEV: Vite is on 5173, Server on 3000. We need explicit URL.
const socket = io(import.meta.env.DEV ? 'http://localhost:3000' : undefined);

function App() {
    const [timeLeft, setTimeLeft] = useState(0);
    const [status, setStatus] = useState('IDLE');

    // inputBuffer now acts as "Draft Mode". If not empty, we are editing.
    const [inputBuffer, setInputBuffer] = useState('');

    // Fix 6: Connection state
    const [connected, setConnected] = useState(socket.connected);

    // Settings & View Modes
    const [overtimeMode, setOvertimeMode] = useState('COUNT_UP');
    const [viewMode, setViewMode] = useState(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get('view') === 'speaker' ? 'SPEAKER' : 'DIRECTOR';
    });
    const [showSettings, setShowSettings] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showFullscreenHint, setShowFullscreenHint] = useState(true);
    const [lanBaseUrl, setLanBaseUrl] = useState(window.location.origin);
    const [tunnelUrl, setTunnelUrl] = useState(null);
    const [tunnelLoading, setTunnelLoading] = useState(false);
    const [tunnelError, setTunnelError] = useState(null);
    const [downloadProgress, setDownloadProgress] = useState(null); // { downloaded, total }
    const speakerUrl = `${tunnelUrl || lanBaseUrl}?view=speaker`;

    // Sync with Server
    useEffect(() => {
        socket.on('timer-update', (state) => {
            setTimeLeft(state.timeLeft);
            setStatus(state.status);
            setOvertimeMode(state.overtimeMode);
        });
        // Fix 6: Track connection state
        socket.on('connect', () => setConnected(true));
        socket.on('disconnect', () => setConnected(false));
        socket.on('server-info', (info) => {
            if (info.addresses && info.addresses.length > 0) {
                setLanBaseUrl(`http://${info.addresses[0]}:${info.port}`);
            }
        });
        socket.on('tunnel-status', (data) => {
            if (data.downloading) {
                setDownloadProgress({ downloaded: 0, total: 0 });
                return;
            }
            setTunnelLoading(false);
            setDownloadProgress(null);
            setTunnelUrl(data.url || null);
            setTunnelError(data.error || null);
        });
        socket.on('tunnel-download-progress', (data) => {
            setDownloadProgress(data);
        });
        socket.on('server-shutdown', () => {
            document.title = 'Sun Stop - Server Spento';
            try { window.close(); } catch { /* browser may block */ }
        });
        return () => {
            socket.off('timer-update');
            socket.off('connect');
            socket.off('disconnect');
            socket.off('server-info');
            socket.off('tunnel-status');
            socket.off('tunnel-download-progress');
            socket.off('server-shutdown');
        };
    }, []);

    // Parse Buffer helper
    const parseBufferToTime = (buffer) => {
        const minutes = parseInt(buffer.slice(0, buffer.length - 2) || '0', 10);
        const seconds = parseInt(buffer.slice(-2) || '0', 10);
        return minutes * 60 + seconds;
    };

    const formatBuffer = (buffer) => {
        const minutes = buffer.slice(0, buffer.length - 2) || '0';
        const seconds = buffer.slice(-2) || '0';
        return minutes.padStart(2, '0') + ':' + seconds.padStart(2, '0');
    };

    // --- ACTIONS ---
    const sendTime = (time) => socket.emit('set-time', time);
    const sendStart = () => socket.emit('start');
    const sendPause = () => socket.emit('pause');
    const sendStop = () => socket.emit('stop');
    const sendMode = (mode) => socket.emit('set-mode', mode);
    const sendSetAndStart = (time) => socket.emit('set-and-start', time);

    // Keyboard Handlers
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.target.tagName === 'INPUT') return;

            const key = e.key;

            // Numeric Input - ALLOW in ANY state now (Hot-Swap)
            if (/^[0-9]$/.test(key)) {
                setInputBuffer(prev => (prev + key).slice(-4));
                return;
            }

            // View Toggle Shortcut (V) - Local only
            if (key.toLowerCase() === 'v') {
                setViewMode(prev => prev === 'DIRECTOR' ? 'SPEAKER' : 'DIRECTOR');
                return;
            }

            // Fullscreen Toggle (F)
            if (key.toLowerCase() === 'f') {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    document.documentElement.requestFullscreen().catch(() => {});
                }
                return;
            }

            // Controls
            switch (key) {
                case 'Backspace':
                    if (inputBuffer.length > 0) {
                        setInputBuffer(prev => prev.slice(0, -1));
                    } else {
                        // If no buffer, Backspace stops/resets as before?
                        sendStop();
                    }
                    break;
                case 'Escape':
                    if (inputBuffer.length > 0) {
                        // Cancel Edit
                        setInputBuffer('');
                    } else {
                        // Stop Timer
                        sendStop();
                    }
                    break;
                case ' ': // Space
                    e.preventDefault();
                    if (inputBuffer.length > 0) {
                        // CONFIRM -> SET & WAIT
                        const time = parseBufferToTime(inputBuffer);
                        sendTime(time);
                        // sendStop(); REMOVED to prevent reset to 0
                        setInputBuffer('');
                    } else {
                        // Normal toggle behavior
                        if (status === 'IDLE') sendStart();
                        else if (status === 'RUNNING') sendPause();
                        else if (status === 'PAUSED') sendStart();
                        else if (status === 'FINISHED') sendStop();
                    }
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (inputBuffer.length > 0) {
                        // Fix 4: Atomic SET & START
                        const time = parseBufferToTime(inputBuffer);
                        sendSetAndStart(time);
                        setInputBuffer('');
                    } else {
                        // Normal toggle behavior
                        if (status === 'IDLE') sendStart();
                        else if (status === 'RUNNING') sendPause();
                        else if (status === 'PAUSED') sendStart();
                        else if (status === 'FINISHED') sendStop();
                    }
                    break;
                default:
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [status, inputBuffer]);

    // Wrapper functions for UI controls
    const handleStart = () => sendStart();
    const handlePause = () => sendPause();
    const handleStop = () => {
        sendStop();
        setInputBuffer('');
    };
    const handleModeChange = (mode) => sendMode(mode);

    // Fullscreen tracking
    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    const toggleFullscreen = () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen().catch(() => {});
        }
        setShowFullscreenHint(false);
    };

    // Safe reset of showSettings when switching modes
    useEffect(() => {
        if (viewMode === 'SPEAKER') setShowSettings(false);
        // Reset hint when entering speaker mode
        if (viewMode === 'SPEAKER') setShowFullscreenHint(true);
    }, [viewMode]);

    return (
        <div className="flex-col fill-height" style={{
            background: viewMode === 'SPEAKER' ? '#000' : 'var(--bg-primary)',
            transition: 'background 0.5s ease',
            justifyContent: viewMode === 'SPEAKER' ? 'center' : 'flex-start'
        }}>
            {/* Fix 6: Disconnect banner */}
            {!connected && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    background: '#dc2626',
                    color: '#fff',
                    textAlign: 'center',
                    padding: '0.5rem',
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    zIndex: 1000
                }}>
                    Connessione persa - riconnessione in corso...
                </div>
            )}

            {/* Download progress toast - bottom right, non-blocking */}
            {tunnelLoading && downloadProgress && (
                <div style={{
                    position: 'fixed',
                    bottom: '1.5rem',
                    right: '1.5rem',
                    background: '#1e293b',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '10px',
                    padding: '0.75rem 1rem',
                    width: '260px',
                    zIndex: 2000,
                    boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
                }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                        Scaricamento tunnel...
                    </div>
                    <div style={{
                        width: '100%',
                        height: '6px',
                        background: 'rgba(255,255,255,0.1)',
                        borderRadius: '3px',
                        overflow: 'hidden',
                        marginBottom: '0.4rem'
                    }}>
                        <div style={{
                            height: '100%',
                            background: 'var(--accent-color)',
                            borderRadius: '3px',
                            transition: 'width 0.3s ease',
                            width: downloadProgress.total > 0
                                ? `${Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)}%`
                                : '0%'
                        }} />
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                        {downloadProgress.total > 0
                            ? `${(downloadProgress.downloaded / 1048576).toFixed(1)} / ${(downloadProgress.total / 1048576).toFixed(1)} MB (${Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)}%)`
                            : 'Avvio download...'}
                    </div>
                </div>
            )}

            {/* Settings dropdown - rendered at root level to avoid overflow:hidden clipping */}
            {showSettings && (
                <>
                    <div
                        style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }}
                        onClick={() => setShowSettings(false)}
                    />
                    <div className="card" style={{
                        position: 'fixed',
                        top: '60px',
                        right: '2rem',
                        width: '280px',
                        zIndex: 100,
                        padding: '1rem',
                        textAlign: 'left'
                    }}>
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>VIEW MODE</h3>
                            <div className="flex-col gap-md">
                                <label style={{ display: 'flex', gap: '0.5rem', cursor: 'pointer', alignItems: 'center' }}>
                                    <input
                                        type="radio"
                                        name="view"
                                        checked={viewMode === 'DIRECTOR'}
                                        onChange={() => setViewMode('DIRECTOR')}
                                    />
                                    <span>Regia (Control View)</span>
                                </label>
                                <label style={{ display: 'flex', gap: '0.5rem', cursor: 'pointer', alignItems: 'center' }}>
                                    <input
                                        type="radio"
                                        name="view"
                                        checked={viewMode === 'SPEAKER'}
                                        onChange={() => setViewMode('SPEAKER')}
                                    />
                                    <span>Relatore (Speaker Only)</span>
                                </label>
                            </div>
                        </div>

                        <div>
                            <h3 style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>OVERTIME BEHAVIOR</h3>
                            <div className="flex-col gap-md">
                                <label style={{ display: 'flex', gap: '0.5rem', cursor: 'pointer', alignItems: 'center' }}>
                                    <input
                                        type="radio"
                                        name="mode"
                                        checked={overtimeMode === 'COUNT_UP'}
                                        onChange={() => handleModeChange('COUNT_UP')}
                                    />
                                    <span>Count Up (Negative)</span>
                                </label>
                                <label style={{ display: 'flex', gap: '0.5rem', cursor: 'pointer', alignItems: 'center' }}>
                                    <input
                                        type="radio"
                                        name="mode"
                                        checked={overtimeMode === 'STOP'}
                                        onChange={() => handleModeChange('STOP')}
                                    />
                                    <span>Stop at 00:00</span>
                                </label>
                            </div>
                        </div>

                        <div style={{ borderTop: '1px solid var(--border-color)', marginTop: '1rem', paddingTop: '1rem' }}>
                            <button
                                onClick={() => {
                                    if (window.confirm('Spegnere il server e chiudere tutto?')) {
                                        socket.emit('shutdown');
                                    }
                                }}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem',
                                    background: '#dc2626',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    fontSize: '0.85rem'
                                }}
                            >
                                Spegni Server e Esci
                            </button>
                        </div>
                    </div>
                </>
            )}

            {/* Header - Only in DIRECTOR mode */}
            <div style={{
                height: viewMode === 'DIRECTOR' ? 'auto' : '0',
                overflow: 'hidden',
                opacity: viewMode === 'DIRECTOR' ? 1 : 0,
                transition: 'all 0.5s ease'
            }}>
                <header style={{
                    padding: '1rem 2rem',
                    borderBottom: '1px solid var(--border-color)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: 'rgba(30, 41, 59, 0.5)',
                    backdropFilter: 'blur(10px)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <img
                            src="/logo192.png"
                            alt="Sun Stop Timer"
                            style={{ width: '32px', height: '32px', borderRadius: '6px' }}
                        />
                        <span style={{ fontWeight: 700, letterSpacing: '-0.02em', fontSize: '1.4rem' }}>Sun Stop Timer</span>
                    </div>

                    <button
                        className="btn btn-text"
                        onClick={() => setShowSettings(!showSettings)}
                        style={{ fontSize: '0.9rem' }}
                    >
                        Settings
                    </button>
                </header>
            </div>

            {/* Main Content */}
            <main className="flex-center flex-col" style={{ flex: 1, position: 'relative', width: '100%', maxWidth: '1200px', margin: '0 auto' }}>

                {/* Timer - Scaled up in Speaker Mode via prop, not transform */}
                <div
                    style={{ width: '100%', cursor: viewMode === 'SPEAKER' ? 'pointer' : 'default' }}
                    onClick={viewMode === 'SPEAKER' ? toggleFullscreen : undefined}
                >
                    <TimerDisplay
                        seconds={timeLeft}
                        status={status}
                        viewMode={viewMode}
                    />
                </div>

                {/* Fullscreen hint - Speaker mode only */}
                {viewMode === 'SPEAKER' && showFullscreenHint && !isFullscreen && (
                    <div
                        onClick={toggleFullscreen}
                        style={{
                            position: 'fixed',
                            bottom: '2rem',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            background: 'rgba(255,255,255,0.1)',
                            color: 'rgba(255,255,255,0.5)',
                            padding: '0.5rem 1.5rem',
                            borderRadius: '8px',
                            fontSize: '0.85rem',
                            cursor: 'pointer',
                            animation: 'fadeOut 5s forwards',
                            zIndex: 10
                        }}
                    >
                        Tap per fullscreen
                    </div>
                )}

                {/* POPUP FOR HOT-SWAP / EDITING */}
                {inputBuffer.length > 0 && (
                    <div style={{
                        position: 'fixed',
                        top: '0', left: '0', width: '100%', height: '100%',
                        background: 'rgba(0,0,0,0.7)',
                        backdropFilter: 'blur(5px)',
                        display: 'flex', justifyContent: 'center', alignItems: 'center',
                        zIndex: 999
                    }}>
                        <div className="card" style={{ padding: '3rem', textAlign: 'center', minWidth: '400px', border: '1px solid var(--accent-color)' }}>
                            <div style={{ fontSize: '1rem', color: 'var(--text-secondary)', marginBottom: '1rem', textTransform: 'uppercase' }}>
                                New Timer
                            </div>
                            <div style={{ fontSize: '5rem', fontWeight: 700, fontFamily: 'monospace', lineHeight: 1, marginBottom: '2rem' }}>
                                {formatBuffer(inputBuffer)}
                            </div>
                            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                <div className="flex-center gap-md">
                                    <kbd className="kbd">Space</kbd> Set & Wait
                                </div>
                                <div className="flex-center gap-md">
                                    <kbd className="kbd">Enter</kbd> Set & START
                                </div>
                                <div className="flex-center gap-md">
                                    <kbd className="kbd">Esc</kbd> Cancel
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Controls - Only in DIRECTOR mode */}
                <div style={{
                    opacity: viewMode === 'DIRECTOR' ? 1 : 0,
                    pointerEvents: viewMode === 'DIRECTOR' ? 'auto' : 'none',
                    transition: 'opacity 0.3s ease',
                    height: viewMode === 'DIRECTOR' ? 'auto' : 0,
                    overflow: 'hidden'
                }}>
                    <div style={{ margin: 'var(--spacing-xl) 0' }}>
                        <Controls
                            status={status}
                            onStart={handleStart}
                            onPause={handlePause}
                            onStop={handleStop}
                            canStart={timeLeft > 0 || inputBuffer.length > 0}
                        />
                    </div>
                </div>

                {/* Footer - Only in DIRECTOR mode */}
                <div style={{
                    opacity: viewMode === 'DIRECTOR' ? 1 : 0,
                    transition: 'opacity 0.3s ease',
                    position: 'absolute',
                    bottom: '2rem',
                    left: '2rem',
                    right: '2rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-end'
                }}>
                    {/* Keyboard shortcuts */}
                    <div style={{
                        display: 'flex',
                        gap: '2rem',
                        color: 'var(--text-secondary)',
                        fontSize: '0.9rem'
                    }}>
                        <div className="flex-center gap-md">
                            <kbd style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>0-9</kbd>
                            <span>Set Time</span>
                        </div>
                        <div className="flex-center gap-md">
                            <kbd style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>Space</kbd>
                            <span>Wait</span>
                        </div>
                        <div className="flex-center gap-md">
                            <kbd style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>Enter</kbd>
                            <span>Start</span>
                        </div>
                        <div className="flex-center gap-md">
                            <kbd style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>V</kbd>
                            <span>View</span>
                        </div>
                        <div className="flex-center gap-md">
                            <kbd style={{ background: 'rgba(255,255,255,0.1)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>F</kbd>
                            <span>Fullscreen</span>
                        </div>
                    </div>

                    {/* QR Code + Speaker Link + Tunnel */}
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '0.5rem'
                    }}>
                        <div style={{
                            background: '#fff',
                            padding: '6px',
                            borderRadius: '8px',
                            lineHeight: 0
                        }}>
                            <QRCodeSVG
                                value={speakerUrl}
                                size={80}
                            />
                        </div>
                        <a
                            href={speakerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                                color: 'var(--accent-color)',
                                fontSize: '0.75rem',
                                textDecoration: 'none',
                                opacity: 0.8
                            }}
                        >
                            {tunnelUrl ? 'Internet' : 'LAN'} Speaker View
                        </a>
                        <button
                            onClick={() => {
                                if (tunnelUrl) {
                                    socket.emit('stop-tunnel');
                                } else {
                                    setTunnelLoading(true);
                                    socket.emit('start-tunnel');
                                }
                            }}
                            disabled={tunnelLoading}
                            style={{
                                background: tunnelUrl ? 'var(--danger-color)' : 'rgba(255,255,255,0.1)',
                                color: tunnelUrl ? '#fff' : 'var(--text-secondary)',
                                border: 'none',
                                borderRadius: '4px',
                                padding: '0.25rem 0.6rem',
                                fontSize: '0.7rem',
                                cursor: tunnelLoading ? 'wait' : 'pointer',
                                opacity: tunnelLoading ? 0.5 : 1
                            }}
                        >
                            {tunnelLoading
                                ? (downloadProgress && downloadProgress.total > 0 ? 'Scaricamento...' : 'Connessione...')
                                : tunnelUrl ? 'Chiudi Internet' : tunnelError ? 'Riprova' : 'Condividi via Internet'}
                        </button>
                        {tunnelError && !tunnelLoading && (
                            <span style={{ color: 'var(--danger-color)', fontSize: '0.65rem' }}>{tunnelError}</span>
                        )}
                    </div>
                </div>

            </main>
        </div>
    )
}

export default App
