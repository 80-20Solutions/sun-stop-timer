import React from 'react';

const TimerDisplay = ({ seconds, status, viewMode }) => {

    const formatTime = (totalSeconds) => {
        const isNegative = totalSeconds < 0;
        const absSeconds = Math.abs(totalSeconds);
        const m = Math.floor(absSeconds / 60);
        const s = absSeconds % 60;

        const mm = String(m).padStart(2, '0');
        const ss = String(s).padStart(2, '0');

        return `${isNegative ? '-' : ''}${mm}:${ss}`;
    };

    // Critical state: Time is 0 OR Negative (in overrun)
    const isCritical = seconds <= 0 && status !== 'IDLE';
    const isBlinking = isCritical;
    const isSpeaker = viewMode === 'SPEAKER';

    return (
        <div className="timer-display" style={{
            textAlign: 'center',
            width: '100%',
            height: isSpeaker ? '100vh' : 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        }}>
            <h1 className={`text-mono ${isBlinking ? 'blink-red' : ''}`} style={{
                fontSize: isSpeaker ? '25vw' : '15vw', // Reduced to 25vw to fit 00:00 without clipping
                fontWeight: 700,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-primary)',
                textShadow: '0 0 40px rgba(56, 189, 248, 0.1)',
                transition: 'all 0.5s ease'
            }}>
                {formatTime(seconds)}
            </h1>
        </div>
    );
};

export default TimerDisplay;
