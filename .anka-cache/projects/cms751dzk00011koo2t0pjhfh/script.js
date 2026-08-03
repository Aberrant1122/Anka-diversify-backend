document.addEventListener('DOMContentLoaded', () => {
    const display = document.querySelector('#display');
    const buttons = document.querySelectorAll('.btn');
    let currentInput = '0';
    let previousInput = '';
    let operator = null;

    buttons.forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.action;
            const value = button.dataset.value;

            if (value) {
                handleNumber(value);
            } else if (action) {
                handleAction(action);
            }
            updateDisplay();
        });
    });

    function handleNumber(value) {
        if (currentInput === 'Error') currentInput = '0';
        if (currentInput.includes('.') && value === '.') return;
        if (currentInput.length >= 15) return; // Limit input length
        if (currentInput === '0' && value !== '.') {
            currentInput = value;
        } else if (currentInput === '0' && value === '0') {
            return; // Prevent multiple leading zeros
        } else {
            currentInput += value;
        }
    }

    function handleAction(action) {
        if (currentInput === 'Error') {
            if (action === 'clear') {
                currentInput = '0';
                previousInput = '';
                operator = null;
            }
            return; // Prevent actions if current input is 'Error'
        }
        switch (action) {
            case 'clear':
                currentInput = '0';
                previousInput = '';
                operator = null;
                break;
            case 'backspace':
                currentInput = currentInput.slice(0, -1) || '0';
                break;
            case 'percent':
                currentInput = (parseFloat(currentInput) / 100).toString();
                break;
            case 'add':
            case 'subtract':
            case 'multiply':
            case 'divide':
                if (previousInput === 'Error') return; // Prevent setting operator if previous input is 'Error'
                if (previousInput !== '') {
                    calculate();
                }
                operator = action;
                previousInput = currentInput;
                currentInput = '0';
                break;
            case 'equals':
                if (operator && previousInput !== '' && currentInput !== '') {
                    calculate();
                }
                operator = null;
                previousInput = '';
                break;
        }
    }

    function calculate() {
        if (currentInput === 'Error' || previousInput === 'Error') return; // Prevent calculation if any input is 'Error'
        const prev = parseFloat(previousInput);
        const current = parseFloat(currentInput);
        if (isNaN(prev) || isNaN(current) || operator === null) return;
        let result;
        switch (operator) {
            case 'add':
                result = prev + current;
                break;
            case 'subtract':
                result = prev - current;
                break;
            case 'multiply':
                result = prev * current;
                break;
            case 'divide':
                if (current === 0) {
                    currentInput = 'Error';
                    previousInput = '';
                    operator = null;
                    return;
                }
                result = prev / current;
                break;
            default:
                return; // Handle unexpected operator
        }
        currentInput = result.toString();
        previousInput = '';
    }

    function updateDisplay() {
        display.textContent = currentInput === 'Error' ? 'Error' : currentInput || '0';
    }

    document.addEventListener('keydown', (event) => {
        if (event.key >= 0 && event.key <= 9) {
            event.preventDefault();
            handleNumber(event.key);
        } else if (event.key === '.') {
            event.preventDefault();
            handleNumber('.');
        } else if (event.key === 'Backspace') {
            event.preventDefault();
            handleAction('backspace');
        } else if (event.key === 'Enter' || event.key === '=') {
            event.preventDefault();
            handleAction('equals');
        } else if (event.key === '+') {
            event.preventDefault();
            handleAction('add');
        } else if (event.key === '-') {
            event.preventDefault();
            handleAction('subtract');
        } else if (event.key === '*') {
            event.preventDefault();
            handleAction('multiply');
        } else if (event.key === '/') {
            event.preventDefault();
            handleAction('divide');
        } else if (event.key === 'Escape') {
            event.preventDefault();
            handleAction('clear');
        } else if (event.key === '%') {
            event.preventDefault();
            handleAction('percent');
        }
        updateDisplay();
    });
});