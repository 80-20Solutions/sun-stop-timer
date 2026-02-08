import React from 'react';

const Controls = ({ status, onStart, onPause, onStop, canStart }) => {
    return (
        <div className="controls" style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>

            {status === 'IDLE' && (
                <button
                    className="btn btn-primary"
                    onClick={onStart}
                    disabled={!canStart}
                    style={{
                        minWidth: '150px',
                        opacity: canStart ? 1 : 0.5,
                        cursor: canStart ? 'pointer' : 'not-allowed'
                    }}
                >
                    Start
                </button>
            )}

            {(status === 'RUNNING' || status === 'PAUSED') && (
                <>
                    {status === 'RUNNING' ? (
                        <button className="btn" onClick={onPause} style={{ minWidth: '120px' }}>
                            Pause
                        </button>
                    ) : (
                        <button className="btn btn-primary" onClick={onStart} style={{ minWidth: '120px' }}>
                            Resume
                        </button>
                    )}

                    <button className="btn btn-danger" onClick={onStop} style={{ minWidth: '120px' }}>
                        Stop
                    </button>
                </>
            )}

            {status === 'FINISHED' && (
                <button className="btn btn-danger" onClick={onStop}>
                    Reset
                </button>
            )}

        </div>
    );
};

export default Controls;
