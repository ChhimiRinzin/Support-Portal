async function loadForm(containerId, category, onSubmitSuccess) {
    try {
        const response = await fetch(`forms/${category}.json`);
        const schema = await response.json();
        const container = document.getElementById(containerId);
        let html = `<h2>${schema.title}</h2><form id="dynamicForm">`;
        for (const field of schema.fields) {
            if (field.type === 'text') {
                html += `<div><label>${field.label}</label><input type="text" name="${field.name}" ${field.required ? 'required' : ''}></div>`;
            } else if (field.type === 'textarea') {
                html += `<div><label>${field.label}</label><textarea name="${field.name}" rows="3"></textarea></div>`;
            } else if (field.type === 'select') {
                html += `<div><label>${field.label}</label><select name="${field.name}">${field.options.map(opt => `<option>${opt}</option>`).join('')}</select></div>`;
            }
        }
        html += `<button type="submit" class="btn-primary">Submit Request</button></form>`;
        container.innerHTML = html;
        document.getElementById('dynamicForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = {};
            for (const field of schema.fields) {
                const input = document.querySelector(`[name="${field.name}"]`);
                if (input) formData[field.name] = input.value;
            }
            const payload = {
                category: category,
                title: formData.title || `${category} request`,
                description: JSON.stringify(formData),
                form_data: formData,
                priority: 'normal'
            };
            try {
                const result = await apiCall('/requests', { method: 'POST', body: JSON.stringify(payload) });
                if (onSubmitSuccess) onSubmitSuccess(result);
            } catch (err) { alert(err.message); }
        });
    } catch (err) {
        document.getElementById(containerId).innerHTML = `<p>Error loading form: ${err.message}</p>`;
    }
}
window.loadForm = loadForm;