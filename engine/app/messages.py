"""
All user-facing messages. Zero technical terms.
Every status, error, and success message the user sees is defined here.
"""

# --- Task lifecycle ---
TASK_STARTING = "Got it — working on that now."
TASK_NAVIGATING = "Opening the website..."
TASK_READING_PAGE = "Looking at the page..."
TASK_PERFORMING_ACTION = "Performing an action..."
TASK_TYPING = "Typing information..."
TASK_SCROLLING = "Scrolling to find more..."
TASK_SELECTING = "Making a selection..."
TASK_WAITING = "Waiting for the page to load..."
TASK_VERIFYING = "Checking if that worked..."
TASK_COMPLETE = "All done!"
TASK_FAILED = "I wasn't able to complete that. Here's what happened: {reason}"
TASK_STUCK = "I got stuck and couldn't find a way forward. You may need to try a different approach."

# --- Budget limits ---
BUDGET_STEPS_EXCEEDED = "I've taken too many steps on this task. Let me know if you'd like me to try a different approach."
BUDGET_TIME_EXCEEDED = "This is taking longer than expected. Let me know if you'd like me to try again."
BUDGET_COST_EXCEEDED = "I've reached the limit for this task. Please try again or simplify the request."

# --- Confirmation ---
CONFIRM_ACTION = "I'm about to {action}. Should I go ahead? (yes/no)"
CONFIRM_PURCHASE = "This looks like a purchase or payment. I need your confirmation before proceeding."

# --- Login ---
LOGIN_NEEDED = "This site requires you to log in. Please log in through the browser window and let me know when you're ready to continue."
LOGIN_DETECTED = "I noticed a login page. I'll need you to sign in first."

# --- CAPTCHA ---
CAPTCHA_DETECTED = "There's a verification check on this page. Trying to handle it automatically..."
CAPTCHA_SOLVED = "Verification complete, continuing..."
CAPTCHA_MANUAL = "I need your help with a verification check. Please solve it in the browser window and let me know when you're done."

# --- Safety ---
BLOCKED_ACTION = "I can't do that — it's a sensitive action that could cause unintended consequences."
SAFETY_BLOCKED = "For safety, I'm not able to perform that action."

# --- Classification ---
CHAT_RESPONSE = "{response}"
QUESTION_RESPONSE = "{answer}"
AMBIGUOUS_REQUEST = "Could you be more specific? I can browse the web and complete tasks for you. What would you like me to do?"

# --- Auth ---
AUTH_SIGNUP_SUCCESS = "Account created. You're all set."
AUTH_LOGIN_SUCCESS = "Logged in successfully."
AUTH_INVALID_CREDENTIALS = "The username or password is incorrect."
AUTH_USER_EXISTS = "An account with that username already exists."
AUTH_TOKEN_INVALID = "Your session has expired. Please log in again."
AUTH_MISSING_FIELDS = "Please provide both a username and password."

# --- Connection ---
CONNECTION_ERROR = "Something went wrong on my end. Please try again in a moment."
BROWSER_ERROR = "I had trouble loading the page. Let me try again."

# --- Progress ---
STEP_PROGRESS = "Step {current} — {description}"
MIDTASK_CHECK = "Checking progress so far..."
TRYING_ALTERNATIVE = "That approach didn't work. Trying something different..."

# --- Loop detection ---
LOOP_DETECTED = "I seem to be repeating myself. Let me try a different approach."
