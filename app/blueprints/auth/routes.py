from flask import render_template, redirect, url_for, request
from flask_login import login_user, logout_user, current_user, login_required
from app.blueprints.auth import auth_bp
from app.models import User
from werkzeug.security import generate_password_hash, check_password_hash

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password, password):
            login_user(user)
            return redirect(url_for('dashboard.dashboard'))
    return render_template('auth.html')

@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))